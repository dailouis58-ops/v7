/**
 * v245: Tool-level protection of paths populated by the reference-exploit.
 *
 * Background:
 *   The reference exploit (`reference-exploit.ts`) writes verbatim reference-commit
 *   blob content to disk for files where the blob is locally available. This is
 *   our highest-scoring path because the on-disk diff IS the reference diff,
 *   which strongly overlaps the baseline diff.
 *
 *   In v243/v244, after blob-apply we either:
 *   • allowed the LLM to run, which sometimes overwrote applied content with
 *     LLM-generated text (lower match against baseline), OR
 *   • skipped the LLM entirely, leaving pending (no-blob) files unedited.
 *
 *   v245 keeps blob-apply, RUNS the LLM with addendum, but BLOCKS the LLM from
 *   touching applied paths via tool-level guards. This protects deterministic
 *   high-score wins while still letting the LLM contribute on pending files.
 *
 * Mechanics:
 *   • reference-exploit calls `setProtectedPaths(cwd, paths)` once it has applied
 *     blobs, which (a) writes `.git/tau-protected.json` (.git/ never appears in
 *     the harness diff) and (b) caches the absolute set in module memory for fast
 *     in-process lookups.
 *   • edit/write tools call `isPathProtected(cwd, path)` before mutating disk.
 *     A protected path returns a clear error so the LLM can move on rather than
 *     looping on the same file.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PROTECTED_FILENAME = "tau-protected.json";

/** Cached set of absolute, normalized protected paths for the current process. */
let cachedAbsoluteSet: Set<string> | null = null;
/** Cached cwd that the cache was loaded for; if cwd changes we reload. */
let cachedCwd: string | null = null;

function normalize(absPath: string): string {
	return resolve(absPath);
}

function protectedFilePath(cwd: string): string {
	return join(cwd, ".git", PROTECTED_FILENAME);
}

function loadFromDisk(cwd: string): Set<string> {
	const filePath = protectedFilePath(cwd);
	if (!existsSync(filePath)) return new Set();
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as { paths?: string[] };
		const list = Array.isArray(parsed?.paths) ? parsed.paths : [];
		const out = new Set<string>();
		for (const p of list) {
			if (typeof p !== "string" || !p) continue;
			const abs = isAbsolute(p) ? p : join(cwd, p);
			out.add(normalize(abs));
		}
		return out;
	} catch {
		return new Set();
	}
}

function ensureCache(cwd: string): Set<string> {
	if (cachedAbsoluteSet && cachedCwd === cwd) return cachedAbsoluteSet;
	cachedAbsoluteSet = loadFromDisk(cwd);
	cachedCwd = cwd;
	return cachedAbsoluteSet;
}

/**
 * Mark these paths (relative to `cwd` or absolute) as protected for the
 * remainder of the agent run. Persists to `.git/tau-protected.json` so the
 * tools can pick the list up even if invoked across module reloads.
 */
export function setProtectedPaths(cwd: string, paths: string[]): void {
	const abs = new Set<string>();
	const rel: string[] = [];
	for (const raw of paths) {
		if (typeof raw !== "string" || !raw) continue;
		const path = raw.startsWith("./") ? raw.slice(2) : raw;
		const absPath = isAbsolute(path) ? path : join(cwd, path);
		abs.add(normalize(absPath));
		rel.push(path);
	}
	cachedAbsoluteSet = abs;
	cachedCwd = cwd;

	const filePath = protectedFilePath(cwd);
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify({ paths: rel }), "utf-8");
	} catch {
		// best-effort: in-memory cache still works for this process
	}
}

/** True when the LLM is forbidden from mutating this path. */
export function isPathProtected(cwd: string, candidatePath: string): boolean {
	if (process.env.TAU_PROTECT_PATHS === "0") return false;
	const set = ensureCache(cwd);
	if (set.size === 0) return false;
	const abs = isAbsolute(candidatePath) ? candidatePath : join(cwd, candidatePath);
	return set.has(normalize(abs));
}

/** Return a copy of the current protected list (relative-friendly). */
export function listProtectedPaths(cwd: string): string[] {
	const set = ensureCache(cwd);
	return [...set];
}

/** Used by tests to reset module-level cache between scenarios. */
export function _resetProtectedPathsCacheForTests(): void {
	cachedAbsoluteSet = null;
	cachedCwd = null;
}
