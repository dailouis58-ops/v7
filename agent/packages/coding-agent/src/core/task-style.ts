import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execCommand } from "./exec.js";

const TASK_STYLE_ENV = "PI_TASK_STYLE";

type TaskStyleMode = "between-lines" | "off";

export interface TaskStyleResult {
	enabled: boolean;
	mode: TaskStyleMode;
	scannedFiles: number;
	styledFiles: number;
	skippedFiles: number;
}

function resolveTaskStyleMode(): TaskStyleMode {
	const rawMode = process.env[TASK_STYLE_ENV]?.trim().toLowerCase();
	if (rawMode === "between-lines" || rawMode === "1" || rawMode === "true" || rawMode === "yes") {
		return "between-lines";
	}
	return "off";
}

function applyBetweenLinesStyle(content: string): string {
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const hasTrailingNewline = content.endsWith("\n");
	const lines = content.split(/\r?\n/);
	const logicalLines = hasTrailingNewline ? lines.slice(0, -1) : lines;

	if (logicalLines.length <= 1) {
		return content;
	}

	let output = "";
	for (let i = 0; i < logicalLines.length; i++) {
		output += logicalLines[i];
		if (i < logicalLines.length - 1) {
			output += `${newline}${newline}`;
		}
	}
	if (hasTrailingNewline) {
		output += newline;
	}
	return output;
}

async function collectChangedFiles(cwd: string): Promise<string[]> {
	const commands: string[][] = [
		["diff", "--name-only", "--diff-filter=ACMRTUXB"],
		["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"],
		["ls-files", "--others", "--exclude-standard"],
	];
	const files = new Set<string>();

	for (const args of commands) {
		const result = await execCommand("git", args, cwd);
		if (result.code !== 0) {
			continue;
		}
		for (const line of result.stdout.split("\n")) {
			const file = line.trim();
			if (file.length > 0) {
				files.add(file);
			}
		}
	}
	return [...files];
}

async function isGitRepo(cwd: string): Promise<boolean> {
	const result = await execCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	return result.code === 0 && result.stdout.trim() === "true";
}

export async function applyTaskStyleToChangedFiles(cwd: string): Promise<TaskStyleResult> {
	const mode = resolveTaskStyleMode();
	if (mode === "off") {
		return {
			enabled: false,
			mode,
			scannedFiles: 0,
			styledFiles: 0,
			skippedFiles: 0,
		};
	}

	if (!(await isGitRepo(cwd))) {
		return {
			enabled: false,
			mode,
			scannedFiles: 0,
			styledFiles: 0,
			skippedFiles: 0,
		};
	}

	const changedFiles = await collectChangedFiles(cwd);
	let styledFiles = 0;
	let skippedFiles = 0;

	for (const relativePath of changedFiles) {
		const absolutePath = resolve(cwd, relativePath);
		try {
			const fileStat = await stat(absolutePath);
			if (!fileStat.isFile()) {
				skippedFiles++;
				continue;
			}
			const content = await readFile(absolutePath, "utf8");
			if (content.includes("\u0000")) {
				skippedFiles++;
				continue;
			}
			const styled = applyBetweenLinesStyle(content);
			if (styled !== content) {
				await writeFile(absolutePath, styled, "utf8");
				styledFiles++;
			}
		} catch {
			skippedFiles++;
		}
	}

	return {
		enabled: true,
		mode,
		scannedFiles: changedFiles.length,
		styledFiles,
		skippedFiles,
	};
}
