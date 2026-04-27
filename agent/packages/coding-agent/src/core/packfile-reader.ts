/**
 * Direct packfile reader for extracting git objects from .pack/.idx files.
 *
 * In partial clones (git clone --filter=blob:none), git marks many blobs as
 * "promised" via .promisor files. Even when the actual blob data IS physically
 * present in the packfile (downloaded by `git fetch --depth=2`), git refuses
 * to serve them via `git cat-file -p` in offline (--network none) containers
 * because the promisor mechanism triggers a lazy fetch that fails.
 *
 * This module bypasses git entirely by reading the binary packfile format
 * directly, resolving delta chains (OFS_DELTA / REF_DELTA) in-process.
 *
 * Only uses node:fs, node:path, node:zlib, node:crypto — no external deps.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

function typeToString(t: number): string {
	switch (t) {
		case OBJ_COMMIT: return "commit";
		case OBJ_TREE: return "tree";
		case OBJ_BLOB: return "blob";
		case OBJ_TAG: return "tag";
		default: return `unknown(${t})`;
	}
}

interface PackIndex {
	fanout: Uint32Array;
	shas: string[];
	offsets: number[];
	shaToOffset: Map<string, number>;
}

function readUint32BE(buf: Buffer, offset: number): number {
	return buf.readUInt32BE(offset);
}

/**
 * Parse a v2 .idx file. Format:
 *   [0..3]   magic  0xff744f63
 *   [4..7]   version = 2
 *   [8..1031] fanout[256] — cumulative object counts (uint32 BE each)
 *   Then: N * 20-byte SHA-1 entries (sorted)
 *   Then: N * 4-byte CRC32 entries
 *   Then: N * 4-byte offset entries (high bit set → large offset table)
 *   Then: variable-length large offset table (8 bytes each)
 *   Then: 20-byte packfile checksum + 20-byte idx checksum
 */
function parseIdx(buf: Buffer): PackIndex | null {
	if (buf.length < 1032) return null;
	const magic = readUint32BE(buf, 0);
	const version = readUint32BE(buf, 4);
	if (magic !== 0xff744f63 || version !== 2) return null;

	const fanout = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		fanout[i] = readUint32BE(buf, 8 + i * 4);
	}
	const numObjects = fanout[255];
	if (numObjects === 0) return null;

	const shaStart = 8 + 256 * 4;
	const crcStart = shaStart + numObjects * 20;
	const offsetStart = crcStart + numObjects * 4;
	const largeOffsetStart = offsetStart + numObjects * 4;

	if (buf.length < largeOffsetStart) return null;

	const shas: string[] = new Array(numObjects);
	const shaToOffset = new Map<string, number>();
	const offsets: number[] = new Array(numObjects);

	for (let i = 0; i < numObjects; i++) {
		const sha = buf.subarray(shaStart + i * 20, shaStart + (i + 1) * 20).toString("hex");
		shas[i] = sha;
	}

	for (let i = 0; i < numObjects; i++) {
		let off = readUint32BE(buf, offsetStart + i * 4);
		if (off & 0x80000000) {
			const largeIdx = off & 0x7fffffff;
			const largeOff = largeOffsetStart + largeIdx * 8;
			if (largeOff + 8 > buf.length) return null;
			const hi = readUint32BE(buf, largeOff);
			const lo = readUint32BE(buf, largeOff + 4);
			off = hi * 0x100000000 + lo;
		}
		offsets[i] = off;
		shaToOffset.set(shas[i], off);
	}

	return { fanout, shas, offsets, shaToOffset };
}

interface RawObject {
	type: number; // 1-4 for base types, 6/7 for deltas
	data: Buffer;
	baseOffset?: number;    // for OFS_DELTA
	baseSha?: string;       // for REF_DELTA
}

/**
 * Read a single object entry from the packfile at the given offset.
 * Returns the raw (possibly delta) object data.
 */
function readPackObject(pack: Buffer, offset: number): RawObject | null {
	if (offset >= pack.length) return null;

	let pos = offset;
	const firstByte = pack[pos];
	const type = (firstByte >> 4) & 0x07;
	let size = firstByte & 0x0f;
	let shift = 4;
	pos++;

	while (pack[pos - 1] & 0x80) {
		if (pos >= pack.length) return null;
		size |= (pack[pos] & 0x7f) << shift;
		shift += 7;
		pos++;
	}

	if (type === OBJ_OFS_DELTA) {
		let negOffset = pack[pos] & 0x7f;
		while (pack[pos] & 0x80) {
			pos++;
			if (pos >= pack.length) return null;
			negOffset = ((negOffset + 1) << 7) | (pack[pos] & 0x7f);
		}
		pos++;
		const baseOffset = offset - negOffset;
		try {
			const data = inflateSync(pack.subarray(pos));
			return { type: OBJ_OFS_DELTA, data, baseOffset };
		} catch {
			return null;
		}
	}

	if (type === OBJ_REF_DELTA) {
		if (pos + 20 > pack.length) return null;
		const baseSha = pack.subarray(pos, pos + 20).toString("hex");
		pos += 20;
		try {
			const data = inflateSync(pack.subarray(pos));
			return { type: OBJ_REF_DELTA, data, baseSha };
		} catch {
			return null;
		}
	}

	// Base object types (commit, tree, blob, tag)
	if (type < 1 || type > 4) return null;
	try {
		const data = inflateSync(pack.subarray(pos));
		return { type, data };
	} catch {
		return null;
	}
}

/**
 * Apply a git delta instruction stream to a base buffer.
 * Delta format: <base_size_varint> <result_size_varint> <instructions...>
 *   Copy instruction (bit 7 set): copies bytes from base
 *   Insert instruction (bit 7 clear, 1-127): inserts literal bytes
 */
function applyDelta(base: Buffer, delta: Buffer): Buffer | null {
	let pos = 0;

	// Read base size (varint) — used for validation
	let baseSize = 0;
	let shift = 0;
	while (pos < delta.length) {
		const b = delta[pos++];
		baseSize |= (b & 0x7f) << shift;
		shift += 7;
		if (!(b & 0x80)) break;
	}
	if (baseSize !== base.length) return null;

	// Read result size (varint)
	let resultSize = 0;
	shift = 0;
	while (pos < delta.length) {
		const b = delta[pos++];
		resultSize |= (b & 0x7f) << shift;
		shift += 7;
		if (!(b & 0x80)) break;
	}

	const result = Buffer.alloc(resultSize);
	let outPos = 0;

	while (pos < delta.length) {
		const cmd = delta[pos++];
		if (cmd === 0) return null; // reserved

		if (cmd & 0x80) {
			// Copy from base
			let copyOffset = 0;
			let copySize = 0;

			if (cmd & 0x01) copyOffset  = delta[pos++];
			if (cmd & 0x02) copyOffset |= delta[pos++] << 8;
			if (cmd & 0x04) copyOffset |= delta[pos++] << 16;
			if (cmd & 0x08) copyOffset |= delta[pos++] << 24;

			if (cmd & 0x10) copySize  = delta[pos++];
			if (cmd & 0x20) copySize |= delta[pos++] << 8;
			if (cmd & 0x40) copySize |= delta[pos++] << 16;

			if (copySize === 0) copySize = 0x10000;

			if (copyOffset + copySize > base.length) return null;
			if (outPos + copySize > resultSize) return null;

			base.copy(result, outPos, copyOffset, copyOffset + copySize);
			outPos += copySize;
		} else {
			// Insert literal
			const insertSize = cmd;
			if (pos + insertSize > delta.length) return null;
			if (outPos + insertSize > resultSize) return null;
			delta.copy(result, outPos, pos, pos + insertSize);
			pos += insertSize;
			outPos += insertSize;
		}
	}

	if (outPos !== resultSize) return null;
	return result;
}

interface ResolvedObject {
	type: number; // base type (1-4)
	data: Buffer;
}

/**
 * A PackfileStore holds parsed index + pack data for one .pack file
 * and resolves objects including delta chains.
 */
class PackfileStore {
	private pack: Buffer;
	private idx: PackIndex;
	private resolveCache = new Map<number, ResolvedObject | null>();

	constructor(pack: Buffer, idx: PackIndex) {
		this.pack = pack;
		this.idx = idx;
	}

	hasSha(sha: string): boolean {
		return this.idx.shaToOffset.has(sha);
	}

	getOffsetForSha(sha: string): number | undefined {
		return this.idx.shaToOffset.get(sha);
	}

	/**
	 * Resolve an object at the given pack offset, recursively resolving
	 * delta chains. Returns null if the chain is broken or data is corrupt.
	 */
	resolve(offset: number, depth: number = 0): ResolvedObject | null {
		if (depth > 50) return null; // prevent infinite loops

		const cached = this.resolveCache.get(offset);
		if (cached !== undefined) return cached;

		// Prevent infinite recursion by marking as in-progress
		this.resolveCache.set(offset, null);

		const raw = readPackObject(this.pack, offset);
		if (!raw) return null;

		let result: ResolvedObject | null = null;

		if (raw.type >= OBJ_COMMIT && raw.type <= OBJ_TAG) {
			result = { type: raw.type, data: raw.data };
		} else if (raw.type === OBJ_OFS_DELTA && raw.baseOffset !== undefined) {
			const baseResolved = this.resolve(raw.baseOffset, depth + 1);
			if (baseResolved) {
				const applied = applyDelta(baseResolved.data, raw.data);
				if (applied) {
					result = { type: baseResolved.type, data: applied };
				}
			}
		} else if (raw.type === OBJ_REF_DELTA && raw.baseSha) {
			const baseOff = this.idx.shaToOffset.get(raw.baseSha);
			if (baseOff !== undefined) {
				const baseResolved = this.resolve(baseOff, depth + 1);
				if (baseResolved) {
					const applied = applyDelta(baseResolved.data, raw.data);
					if (applied) {
						result = { type: baseResolved.type, data: applied };
					}
				}
			}
		}

		this.resolveCache.set(offset, result);
		return result;
	}
}

/**
 * MultiPackReader manages all .pack/.idx pairs in a repository and provides
 * a unified interface to read any object by SHA.
 */
export class MultiPackReader {
	private stores: PackfileStore[] = [];
	private shaToStore = new Map<string, PackfileStore>();
	private loaded = false;

	constructor(private gitDir: string) {}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;

		const packDir = join(this.gitDir, "objects", "pack");
		if (!existsSync(packDir)) return;

		let files: string[];
		try {
			files = readdirSync(packDir);
		} catch {
			return;
		}

		const idxFiles = files.filter(f => f.endsWith(".idx"));
		for (const idxFile of idxFiles) {
			const packFile = idxFile.replace(/\.idx$/, ".pack");
			const idxPath = join(packDir, idxFile);
			const packPath = join(packDir, packFile);

			if (!existsSync(packPath)) continue;

			try {
				const idxBuf = readFileSync(idxPath);
				const packBuf = readFileSync(packPath);

				// Validate pack header
				if (packBuf.length < 12) continue;
				const sig = packBuf.subarray(0, 4).toString("ascii");
				if (sig !== "PACK") continue;

				const idx = parseIdx(idxBuf);
				if (!idx) continue;

				const store = new PackfileStore(packBuf, idx);
				this.stores.push(store);

				for (const sha of idx.shas) {
					if (!this.shaToStore.has(sha)) {
						this.shaToStore.set(sha, store);
					}
				}
			} catch {
				// Skip corrupt packs
			}
		}
	}

	/**
	 * Read an object by its full 40-hex SHA. Returns null if not found
	 * in any packfile or if the object/delta chain is corrupt.
	 */
	readObject(sha: string): ResolvedObject | null {
		this.load();

		const store = this.shaToStore.get(sha);
		if (!store) return null;

		const offset = store.getOffsetForSha(sha);
		if (offset === undefined) return null;

		return store.resolve(offset);
	}

	/**
	 * Read a blob by SHA, returning its content as a Buffer.
	 * Returns null if the SHA is not found, not a blob, or corrupt.
	 */
	readBlob(sha: string): Buffer | null {
		const obj = this.readObject(sha);
		if (!obj || obj.type !== OBJ_BLOB) return null;
		return obj.data;
	}

	/**
	 * Check whether a SHA exists in any local packfile.
	 */
	has(sha: string): boolean {
		this.load();
		return this.shaToStore.has(sha);
	}

	/**
	 * Compute the git object SHA (sha1 of "<type> <size>\0<data>") and
	 * verify it matches the expected SHA. Useful for integrity checks.
	 */
	static verifyObjectSha(type: string, data: Buffer, expectedSha: string): boolean {
		const header = `${type} ${data.length}\0`;
		const hash = createHash("sha1");
		hash.update(header);
		hash.update(data);
		const actual = hash.digest("hex");
		return actual === expectedSha;
	}
}

let _cachedReader: MultiPackReader | null = null;
let _cachedReaderGitDir: string | null = null;

/**
 * Get a singleton MultiPackReader for the given git directory.
 * Caches across calls to avoid re-parsing packfiles.
 */
export function getPackReader(cwd: string): MultiPackReader {
	const gitDir = join(cwd, ".git");
	if (_cachedReader && _cachedReaderGitDir === gitDir) {
		return _cachedReader;
	}
	_cachedReader = new MultiPackReader(gitDir);
	_cachedReaderGitDir = gitDir;
	return _cachedReader;
}
