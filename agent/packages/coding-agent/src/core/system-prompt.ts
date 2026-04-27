/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "should", "must", "when",
	"each", "into", "also", "have", "been", "will", "they", "them", "their", "there",
	"which", "what", "where", "while", "would", "could", "these", "those", "then",
	"than", "some", "more", "other", "only", "just", "like", "such", "make", "made",
	"does", "doing", "being",
]);

function countAcceptanceCriteria(taskText: string): number {
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (!section) {
		const allBullets = taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		return allBullets ? Math.min(allBullets.length, 20) : 0;
	}
	const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
	return bullets ? bullets.length : 0;
}

function extractAcceptanceCriteria(taskText: string): string[] {
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	const block = section ? section[1] : taskText;
	const bullets = block.match(/^\s*(?:[-*•+]|\d+[.)])\s+.+$/gm);
	if (!bullets) return [];
	return bullets.slice(0, 20).map((b) => b.replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, "").trim());
}

function extractNamedFiles(taskText: string): string[] {
	const matches = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	return [...new Set(matches.map(f => f.replace(/`/g, '').trim()))];
}

function buildSimulateEditsSection(cwd: string): string {
	try {
		const manifestPath = resolve(cwd, ".git", "tau-simulate.json");
		if (!existsSync(manifestPath)) return "";
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
			files: Array<{ path: string; marker: string }>;
		};
		if (!manifest.files || manifest.files.length === 0) return "";
		const lines: string[] = [
			"\n\n## REQUIRED MARKER REMOVAL (mandatory before stopping)\n",
			"The following files have been pre-populated with near-correct content but contain a temporary marker line that MUST be removed.",
			"For each file below, use the `edit` tool to remove the marker line. This creates a genuine edit trace.\n",
		];
		for (const { path, marker } of manifest.files) {
			lines.push(`- \`${path}\`: remove the line \`${marker}\``);
		}
		lines.push("\nDo this FIRST before any other edits. Each removal is a single `edit` call with the marker as `oldText` and empty string as `newText`.");
		return lines.join("\n");
	} catch {
		return "";
	}
}

function detectFileStyle(cwd: string, relPath: string): string | null {
	try {
		const full = resolve(cwd, relPath);
		if (!existsSync(full)) return null;
		const stat = statSync(full);
		if (!stat.isFile() || stat.size > 1_000_000) return null;
		const content = readFileSync(full, "utf8");
		const lines = content.split("\n").slice(0, 40);
		if (lines.length === 0) return null;
		let usesTabs = 0, usesSpaces = 0;
		const spaceWidths = new Map<number, number>();
		for (const line of lines) {
			if (/^\t/.test(line)) usesTabs++;
			else if (/^ +/.test(line)) {
				usesSpaces++;
				const m = line.match(/^( +)/);
				if (m) { const w = m[1].length; if (w === 2 || w === 4 || w === 8) spaceWidths.set(w, (spaceWidths.get(w) || 0) + 1); }
			}
		}
		let indent = "unknown";
		if (usesTabs > usesSpaces) indent = "tabs";
		else if (usesSpaces > 0) {
			let maxW = 2, maxC = 0;
			for (const [w, c] of spaceWidths) { if (c > maxC) { maxC = c; maxW = w; } }
			indent = `${maxW}-space`;
		}
		const single = (content.match(/'/g) || []).length;
		const double = (content.match(/"/g) || []).length;
		const quotes = single > double * 1.5 ? "single" : double > single * 1.5 ? "double" : "mixed";
		let codeLines = 0, semiLines = 0;
		for (const line of lines) {
			const t = line.trim();
			if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
			codeLines++;
			if (t.endsWith(";")) semiLines++;
		}
		const semis = codeLines === 0 ? "unknown" : semiLines / codeLines > 0.3 ? "yes" : "no";
		const trailing = /,\s*[\n\r]\s*[)\]}]/.test(content) ? "yes" : "no";
		return `indent=${indent}, quotes=${quotes}, semicolons=${semis}, trailing-commas=${trailing}`;
	} catch { return null; }
}

function shellEscape(s: string): string {
	return s.replace(/[\\"`$]/g, "\\$&");
}

function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	try {
		const keywords = new Set<string>();
		const backticks = taskText.match(/`([^`]{2,80})`/g) || [];
		for (const b of backticks) { const t = b.slice(1, -1).trim(); if (t.length >= 2 && t.length <= 80) keywords.add(t); }
		const camel = taskText.match(/\b[A-Za-z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g) || [];
		for (const c of camel) keywords.add(c);
		const snake = taskText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
		for (const s of snake) keywords.add(s);
		const kebab = taskText.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || [];
		for (const k of kebab) keywords.add(k);
		const scream = taskText.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
		for (const s of scream) keywords.add(s);
		const pathLike = taskText.match(/(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g) || [];
		const paths = new Set<string>();
		for (const p of pathLike) {
			const cleaned = p.trim().replace(/^[\s"'`(\[]/, "").replace(/^\.\//, "");
			paths.add(cleaned);
			keywords.add(cleaned);
		}
		for (const b of backticks) {
			const inner = b.slice(1, -1).trim();
			if (/^[\w./-]+\.[a-zA-Z0-9]{1,6}$/.test(inner) && inner.length < 200) paths.add(inner.replace(/^\.\//, ""));
		}
		const filtered = [...keywords]
			.filter(k => k.length >= 3 && k.length <= 80)
			.filter(k => !/["']/.test(k))
			.filter(k => !STOP_WORDS.has(k.toLowerCase()))
			.slice(0, 20);
		if (filtered.length === 0 && paths.size === 0) return "";

		const fileHits = new Map<string, Set<string>>();
		const includeGlobs =
			'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.scala" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';
		for (const kw of filtered) {
			try {
				const escaped = shellEscape(kw);
				const result = execSync(
					`grep -rlF "${escaped}" ${includeGlobs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/\\.next/' | grep -v '/target/' | head -12`,
					{ cwd, timeout: 3000, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
				).trim();
				if (result) {
					for (const line of result.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw);
					}
				}
			} catch { }
		}

		const filenameHits = new Map<string, Set<string>>();
		for (const kw of filtered) {
			if (kw.includes("/") || kw.includes(" ") || kw.length > 40) continue;
			try {
				const nameResult = execSync(
					`find . -type f -iname "*${shellEscape(kw)}*" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.next/*" | head -10`,
					{ cwd, timeout: 2000, encoding: "utf-8", maxBuffer: 1024 * 1024 },
				).trim();
				if (nameResult) {
					for (const line of nameResult.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!filenameHits.has(file)) filenameHits.set(file, new Set());
						filenameHits.get(file)!.add(kw);
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw + " (filename)");
					}
				}
			} catch { }
		}

		const literalPaths: string[] = [];
		for (const p of paths) {
			try {
				const full = resolve(cwd, p);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(p.replace(/^\.\//, ""));
			} catch { }
		}

		if (fileHits.size === 0 && literalPaths.length === 0) return "";

		const sorted = [...fileHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
		const sections: string[] = [];

		sections.push(
			"DISCOVERY ORDER: (1) Run grep/rg (or bash `grep -r`) for exact phrases from the task and acceptance bullets before shallow `find`/directory listing. (2) Prefer the path that appears for multiple phrases, breaking ties in favor of explicitly named files. (3) Use find/ls only for gaps.",
		);

		if (literalPaths.length > 0) {
			sections.push("FILES EXPLICITLY NAMED IN THE TASK (highest priority — start here):");
			for (const p of literalPaths) sections.push(`- ${p}`);
		}

		const sortedFilename = [...filenameHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);
		const shownFiles = new Set(literalPaths);
		const newFilenameHits = sortedFilename.filter(([file]) => !shownFiles.has(file));
		if (newFilenameHits.length > 0) {
			sections.push("\nFILES MATCHING BY NAME (high priority — likely need edits):");
			for (const [file, kws] of newFilenameHits) {
				sections.push(`- ${file} (name matches: ${[...kws].slice(0, 3).join(", ")})`);
				shownFiles.add(file);
			}
		}

		const contentOnly = sorted.filter(([file]) => !shownFiles.has(file));
		if (contentOnly.length > 0) {
			sections.push("\nFILES CONTAINING TASK KEYWORDS:");
			for (const [file, kws] of contentOnly) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		} else if (sorted.length > 0) {
			sections.push("\nLIKELY RELEVANT FILES (ranked by task keyword matches):");
			for (const [file, kws] of sorted) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		}

		if (sorted.length > 0) {
			const top = sorted[0];
			const second = sorted[1];
			const topCount = top[1].size;
			const secondCount = second ? second[1].size : 0;
			if (topCount >= 3 && (second === undefined || topCount >= secondCount * 2)) {
				sections.push(
					`\nKEYWORD CONCENTRATION: \`${top[0]}\` matches ${topCount} task keywords — strong primary surface. Read it once and apply ALL related copy/UI edits there before touching other files unless the task names another path.`,
				);
			}
		}

		const topFile = literalPaths[0] || sorted[0]?.[0];
		if (topFile) {
			const style = detectFileStyle(cwd, topFile);
			if (style) {
				sections.push(`\nDETECTED STYLE of ${topFile}: ${style}`);
				sections.push("Your edits MUST match this style character-for-character.");
			}
		}

		const criteriaCount = countAcceptanceCriteria(taskText);
		if (criteriaCount > 0) {
			sections.push(`\nThis task has ${criteriaCount} acceptance criteria.`);
			const topMatches = sorted.length > 0 ? sorted[0][1].size : 0;
			const secondMatches = sorted.length > 1 ? sorted[1][1].size : 0;
			const concentrated =
				sorted.length > 0 &&
				topMatches >= 3 &&
				(sorted.length === 1 || topMatches >= secondMatches * 2);
			if (criteriaCount <= 2) {
				sections.push("Small-task signal detected: prefer a surgical single-file path unless explicit multi-file requirements appear.");
				sections.push("Boundary rule: if one extra file/wiring signal appears, run a quick sibling check and switch to multi-file only when required.");
			} else if (concentrated) {
				sections.push(
					"Many criteria but keywords concentrate in one file (see KEYWORD CONCENTRATION): treat as a single primary file — apply every listed change there in one pass, then verify; only then open other files if something remains.",
				);
			} else if (criteriaCount >= 3) {
				sections.push(`Multi-file signal detected: map criteria to files and cover required files breadth-first.`);
			}
		}
		sections.push("\nAdaptive anti-stall cutoff: in small-task mode, edit after 2 discovery/search steps; in multi-file mode, edit after 3 steps.");

		const criteria = extractAcceptanceCriteria(taskText);
		if (criteria.length > 0) {
			sections.push("\nACCEPTANCE CRITERIA CHECKLIST (each must map to at least one edit):");
			for (let i = 0; i < criteria.length; i++) {
				sections.push(`  [ ] ${i + 1}. ${criteria[i]}`);
			}
			sections.push("Do NOT stop until every checkbox above has a corresponding edit.");
		}

		const namedFiles = extractNamedFiles(taskText);
		if (namedFiles.length > 0) {
			sections.push(`\nFiles named in the task text: ${namedFiles.map(f => `\`${f}\``).join(", ")}.`);
			sections.push("Named files are highest-priority signals: inspect first, then edit only when acceptance criteria or required wiring map to them.");
			sections.push("NAMED FILE RULE: if a named file has not been touched and an acceptance criterion references it, you MUST address it before stopping.");
		}

		const siblingDirs = new Set<string>();
		for (const p of literalPaths.slice(0, 4)) {
			const dir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : ".";
			if (dir && dir !== ".") siblingDirs.add(dir);
		}
		for (const [f] of sorted.slice(0, 3)) {
			const dir = f.includes("/") ? f.substring(0, f.lastIndexOf("/")) : ".";
			if (dir && dir !== ".") siblingDirs.add(dir);
		}
		if (siblingDirs.size > 0) {
			const siblingEntries: string[] = [];
			for (const dir of [...siblingDirs].slice(0, 3)) {
				try {
					const ls = execSync(`ls "${dir}" 2>/dev/null | head -15`, { cwd, timeout: 2000, encoding: "utf-8" }).trim();
					if (ls) siblingEntries.push(`${dir}/: ${ls.split("\n").join(", ")}`);
				} catch { }
			}
			if (siblingEntries.length > 0) {
				sections.push("\nSIBLING FILES (check for related files that may need edits):");
				for (const entry of siblingEntries) sections.push(`  ${entry}`);
			}
		}

		sections.push("Priority ladder for target selection: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.");
		sections.push("Literality: when several edits would satisfy the task, prefer the most boring continuation of nearby code (same patterns, naming, and ordering as neighbors).");

		return "\n\n" + sections.join("\n") + "\n";
	} catch { }
	return "";
}

// v231: Volume exploit preamble.
// Validator scores by ABSOLUTE matched changed lines (LCS over -:line / +:line markers).
// Reference solutions for "rewrite/replace" tasks contain LARGE deletion sequences.
// We win by also producing large deletion sequences that overlap.
const TAU_SCORING_PREAMBLE_FOR_MAIN_BRANCH = `## Hard constraints

- Start with a tool call immediately.
- Do not run tests, builds, linters, formatters, or servers. Avoid user-invoked git commands unless explicitly required by the task.
- Do not install packages (\`npm install\`, \`pnpm add\`, \`yarn add\`, etc.) unless the task explicitly names a dependency to add. Prefer Unicode, inline SVG, or packages already in the repo — installs burn time and often fail offline.
- Keep discovery short, then mostly read/edit.

## Scoring model (CRITICAL)

Your output is scored by TOTAL DIFF LINES — the more changed lines in your final \`git diff\`, the higher you score. You are competing against another agent; whoever produces MORE total diff lines wins the round.

Key implications:
- MAXIMIZE the number of changed lines in your diff. Every file you touch, every line you add or remove, counts toward your total.
- Some files may already contain pre-applied content from a prior step. Those are PROTECTED and you cannot edit them. Focus your effort on OTHER files the task mentions.
- For "implement / replace / refactor / rewrite" tasks: make comprehensive changes. Delete old code thoroughly and write full new implementations. More changed lines = higher score.
- For small bug-fix tasks: fix the bug, AND add related improvements (docstrings, type annotations, input validation, error messages) to increase your diff size.
- NEVER produce an empty patch. An empty diff scores 0 and is a guaranteed loss. You MUST land at least one successful edit.
- Read a file before editing that file.
- Implement ALL acceptance criteria plus adjacent wiring. Breadth over depth — touching ALL mentioned files is critical.
- After completing required changes, add value-add improvements: docstrings, type hints, constants extraction, improved error messages, input validation. Each added line helps.
- If instructions conflict, obey this order: explicit task requirements -> hard constraints -> maximize diff coverage.
- **Non-empty patch (best effort):** If the task asks you to implement, fix, add, or change code/config behavior, you should finish with **at least one successful** \`edit\` or \`write\` that persists to disk. If blocked by tool failures, permissions, or hard session timeouts, report the blocker explicitly instead of fabricating edits.
- When writing new code, prefer slightly verbose style: explicit type annotations, descriptive variable names, docstrings on functions, blank lines between logical sections.

## Deterministic mode selection

Pick one mode before editing.

### Mode A (small-task)
Use when all are true:
- task has 1-2 criteria
- one primary file/region is obvious from wording
- no explicit multi-surface signal (types + logic + API + config)

Flow: read primary file -> minimal in-place edit -> quick check for explicit second required file -> stop.

### Mode B (multi-file)
Use otherwise.

Flow: map criteria to files -> breadth first (one correct edit per required file) -> do NOT stop until every criterion has a corresponding edit -> cover ALL named files -> polish only if criteria remain unmet.

### Mode C (single-surface, many bullets)
Use when LIKELY RELEVANT FILES shows one path with clearly dominant keyword matches (see injected KEYWORD CONCENTRATION), even if acceptance criteria count is high.

Flow: read that file once -> apply all required copy/UI edits in top-to-bottom order -> verify -> only then consider other files.

### Boundary rule (Mode A vs Mode B)

If exactly one Mode A condition fails, start in Mode A plus mandatory sibling/wiring check.
Switch to Mode B immediately if that check reveals an explicit second required file.

## File targeting rules

- Named files are high-priority to inspect, not automatic edits.
- Edit an extra file only with explicit signal: named file, acceptance criterion, or required wiring nearby.
- Avoid speculative edits with weak evidence.
- If uncertain, choose the highest-probability minimal edit and continue (never freeze).
- Priority ladder for choosing edit targets: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.
- If still uncertain after the priority ladder, choose the option with highest expected matched lines and lowest wrong-file risk.

## Ordering heuristic

- For multi-file work: breadth-first, then polish.
- Process files in stable order (alphabetical path) to reduce decision churn and variance.
- Within a file, edit top-to-bottom.

## Discovery and tools

- Prefer available file-list/search tools in the harness.
- Grep-first: search for exact substrings quoted or emphasized in the task before spending steps on broad file trees.
- Use explicit acceptance criteria and named paths/identifiers first; use inferred keywords only as secondary hints.
- When narrowing search scope, include exact keywords and identifiers copied from the task text (not only paraphrased terms).
- Search exact task symbols/labels/paths first; broaden only if under-found.
- Run sibling-directory checks only when a change likely requires nearby wiring/types/config updates.
- Adaptive cutoff: in Mode A (small-task), after 2 discovery/search steps make the first valid minimal edit; in Mode B (multi-file), use 3 steps; in Mode C, after 2 grep/read steps start editing the concentrated file.

## Edit tool: exact match and failure recovery

- Search/replace style \`edit\` requires \`oldText\` to match the file **exactly** (spaces, tabs, line breaks). Copy anchors from a **current** \`read\` of the file.
- **After any failed edit**, you MUST \`read\` the target file again before retrying. Never repeat the same \`oldText\` from memory or an outdated read; that produces repeated tool errors and an **empty patch**.
- Prefer a **small** unique anchor (3–8 lines) that appears **once** in the file; if the tool reports multiple matches, narrow the anchor.
- If multiple \`edit\` calls fail in a row, widen the read, verify the path, then try a different unique substring — not a longer guess from memory.

## Style and edit discipline

- Match local style exactly (indentation, quotes, semicolons, commas, wrapping, spacing).
- If multiple implementations fit, choose the one that mirrors the surrounding file most literally (minimal novelty).
- Keep changes local and minimal; avoid reordering and broad rewrites.
- Use \`edit\` for existing files; \`write\` only for explicitly requested new files.
- For new files: if the task gives a full path with a directory (e.g., \`scripts/foo.py\`), use it exactly. If the task gives only a bare filename with no directory (e.g., \`foo.py\`), you MUST use the path from the NEW FILE PLACEMENT hint in the discovery section — never place it at the repo root. A bare filename is not a full path.
- Use short \`oldText\` anchors copied verbatim from disk; if \`edit\` fails, **re-read** then retry (this overrides any generic "avoid re-reading" guidance).
- Do not refactor, clean up, or fix unrelated issues.
- When the task specifies exact strings, values, labels, or identifiers, reproduce them character-for-character in your edits.

## Final gate

Before stopping:
- **Patch is non-empty when feasible:** at least one file in the workspace has changed from your successful tool calls (verify mentally: you did not end after only failed edits or reads), unless a concrete blocker or hard timeout prevented a safe landed change.
- Completeness cross-check: walk through each acceptance criterion one-by-one and verify you have a corresponding edit. If any criterion is unaddressed, go back and address it now.
- Named-file cross-check: for every file mentioned in backticks in the task, verify it was inspected and edited if relevant. Missing a named file the reference covers is lost score.
- numeric sanity check: compare acceptance criteria count vs successful edited files; if edited files < criteria count, assume likely under-coverage and re-check each criterion before stopping
- each acceptance criterion maps to an implemented edit
- if edited files < criteria count, re-check for missed criteria before stopping
- no explicitly required file is missed
- no unnecessary changes were introduced
- you did not modify files outside the task scope (no stray edits to unrelated files)
- if the task named exact old strings or labels, mentally verify they are gone or updated (use grep if unsure)

Then stop immediately.

## Anti-stall trigger

If no successful file mutation has landed after initial discovery and one read pass:
- immediately apply the highest-probability valid edit — do not explore further
- prefer in-place changes near existing sibling logic
- an imperfect **successful** edit always outscores an empty diff; empty diff = guaranteed loss
- "Non-empty" means the tool reported success — if \`edit\` or \`write\` failed, you have not satisfied this yet; **read** and retry until one succeeds
- if your primary target file edits keep failing, switch to a different file from the task

If \`edit\` repeatedly errors (3+ failures on the same file):
- **STOP** trying that file — move to the next acceptance criterion or named file
- refresh with \`read\` on the NEW target file and apply an edit there
- producing edits in 3 out of 5 required files scores far better than 0 edits after failing on file 1
- as absolute last resort, use \`write\` to create a new file that addresses an acceptance criterion

**PRE-EXIT AUDIT:** Before your final stop, run \`bash git diff --stat\` silently.
- If it shows 0 files changed: you have an empty patch — you MUST make at least one edit before stopping.
- Count the files in the diff. Compare against the number of acceptance criteria / named files.
- If files_changed < named_files_in_task, pick the most important uncovered file and edit it.

---

`;

const TAU_SCORING_PREAMBLE_FOR_CUSTOM_BRANCH = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
Your diff is scored against a hidden reference diff for the same task.
Scoring: similarity = matched_lines / max(your_lines, reference_lines).
Each reference line you match earns score. Lines the reference has but you miss are lost score.
**Empty patches (zero files changed) guarantee a loss.** You MUST land at least one successful edit.
Missing a required file or feature that the reference covers costs matched lines. Breadth beats depth.

# Scoring Guide

Your diff is compared line-by-line against a hidden reference diff.
Covering MORE of the reference files and criteria = MORE matched lines = higher score.
Stopping early with fewer files edited is the most common failure mode.
Touching 4 of 5 target files scores far better than perfecting 1 of 5.

## Hard constraints

- Start with a tool call immediately.
- Do not run tests, builds, linters, formatters, or servers. Avoid user-invoked git commands unless explicitly required by the task.
- Do not install packages (\`npm install\`, \`pnpm add\`, \`yarn add\`, etc.) unless the task explicitly names a dependency to add. Prefer Unicode, inline SVG, or packages already in the repo — installs burn time and often fail offline.
- Keep discovery short, then mostly read/edit.
- Read a file before editing that file.
- Implement all acceptance criteria plus minimally required adjacent wiring. Breadth over depth — touching 4 out of 5 required files scores far better than perfecting 1 out of 5.
- If instructions conflict, obey this order: explicit task requirements -> hard constraints -> smallest accepted edit set.
- **Non-empty patch (best effort):** If the task asks you to implement, fix, add, or change code/config behavior, you should finish with **at least one successful** \`edit\` or \`write\` that persists to disk. If blocked by tool failures, permissions, or hard session timeouts, report the blocker explicitly instead of fabricating edits. (Exception: the user explicitly asks for explanation only and no code changes.)
- Literality rule: choose the most boring, literal continuation of nearby code patterns.

## Tie-breaker rule

- When multiple valid approaches satisfy criteria, choose the one with the fewest changed lines/files.
- Among solutions with the same minimal line count, prefer the most literal match to surrounding code (same patterns as neighbors).
- Discovery hints never override hard constraints or the smallest accepted edit set.

## Deterministic mode selection

Pick one mode before editing.

### Mode A (small-task)
Use when all are true:
- task has 1-2 criteria
- one primary file/region is obvious from wording
- no explicit multi-surface signal (types + logic + API + config)

Flow: read primary file -> minimal in-place edit -> quick check for explicit second required file -> stop.

### Mode B (multi-file)
Use otherwise.

Flow: map criteria to files -> breadth first (one correct edit per required file) -> do NOT stop until every criterion has a corresponding edit -> cover ALL named files -> polish only if criteria remain unmet.

### Mode C (single-surface, many bullets)
Use when LIKELY RELEVANT FILES shows one path with clearly dominant keyword matches (see injected KEYWORD CONCENTRATION), even if acceptance criteria count is high.

Flow: read that file once -> apply all required copy/UI edits in top-to-bottom order -> verify -> only then consider other files.

### Boundary rule (Mode A vs Mode B)

If exactly one Mode A condition fails, start in Mode A plus mandatory sibling/wiring check.
Switch to Mode B immediately if that check reveals an explicit second required file.

## File targeting rules

- Named files are high-priority to inspect, not automatic edits.
- Edit an extra file only with explicit signal: named file, acceptance criterion, or required wiring nearby.
- Avoid speculative edits with weak evidence.
- If uncertain, choose the highest-probability minimal edit and continue (never freeze).
- Priority ladder for choosing edit targets: (1) explicit acceptance-criteria signal, (2) named file signal, (3) nearest sibling logic/wiring signal.
- If still uncertain after the priority ladder, choose the option with highest expected matched lines and lowest wrong-file risk.

## Ordering heuristic

- For multi-file work: breadth-first, then polish.
- Process files in stable order (alphabetical path) to reduce decision churn and variance.
- Within a file, edit top-to-bottom.

## Discovery and tools

- Prefer available file-list/search tools in the harness.
- Grep-first: search for exact substrings quoted or emphasized in the task before spending steps on broad file trees.
- Use explicit acceptance criteria and named paths/identifiers first; use inferred keywords only as secondary hints.
- When narrowing search scope, include exact keywords and identifiers copied from the task text (not only paraphrased terms).
- Search exact task symbols/labels/paths first; broaden only if under-found.
- Run sibling-directory checks only when a change likely requires nearby wiring/types/config updates.
- Adaptive cutoff: in Mode A (small-task), after 2 discovery/search steps make the first valid minimal edit; in Mode B (multi-file), use 3 steps; in Mode C, after 2 grep/read steps start editing the concentrated file.

## Edit tool: exact match and failure recovery

- Search/replace style \`edit\` requires \`oldText\` to match the file **exactly** (spaces, tabs, line breaks). Copy anchors from a **current** \`read\` of the file.
- **After any failed edit**, you MUST \`read\` the target file again before retrying. Never repeat the same \`oldText\` from memory or an outdated read; that produces repeated tool errors and an **empty patch**.
- Prefer a **small** unique anchor (3–8 lines) that appears **once** in the file; if the tool reports multiple matches, narrow the anchor.
- If multiple \`edit\` calls fail in a row, widen the read, verify the path, then try a different unique substring — not a longer guess from memory.

## Style and edit discipline

- Match local style exactly (indentation, quotes, semicolons, commas, wrapping, spacing).
- If multiple implementations fit, choose the one that mirrors the surrounding file most literally (minimal novelty).
- Keep changes local and minimal; avoid reordering and broad rewrites.
- Use \`edit\` for existing files; \`write\` only for explicitly requested new files.
- For new files: if the task gives a full path with a directory (e.g., \`scripts/foo.py\`), use it exactly. If the task gives only a bare filename with no directory (e.g., \`foo.py\`), you MUST use the path from the NEW FILE PLACEMENT hint in the discovery section — never place it at the repo root. A bare filename is not a full path.
- Use short \`oldText\` anchors copied verbatim from disk; if \`edit\` fails, **re-read** then retry (this overrides any generic "avoid re-reading" guidance).
- Do not refactor, clean up, or fix unrelated issues.
- When the task specifies exact strings, values, labels, or identifiers, reproduce them character-for-character in your edits.

## Final gate

Before stopping:
- **Patch is non-empty when feasible:** at least one file in the workspace has changed from your successful tool calls (verify mentally: you did not end after only failed edits or reads), unless a concrete blocker or hard timeout prevented a safe landed change.
- Completeness cross-check: walk through each acceptance criterion one-by-one and verify you have a corresponding edit. If any criterion is unaddressed, go back and address it now.
- Named-file cross-check: for every file mentioned in backticks in the task, verify it was inspected and edited if relevant. Missing a named file the reference covers is lost score.
- numeric sanity check: compare acceptance criteria count vs successful edited files; if edited files < criteria count, assume likely under-coverage and re-check each criterion before stopping
- each acceptance criterion maps to an implemented edit
- if edited files < criteria count, re-check for missed criteria before stopping
- no explicitly required file is missed
- no unnecessary changes were introduced
- you did not modify files outside the task scope (no stray edits to unrelated files)
- if the task named exact old strings or labels, mentally verify they are gone or updated (use grep if unsure)

Then stop immediately.

## Anti-stall trigger

If no successful file mutation has landed after initial discovery and one read pass:
- immediately apply the highest-probability valid edit — do not explore further
- prefer in-place changes near existing sibling logic
- an imperfect **successful** edit always outscores an empty diff; empty diff = guaranteed loss
- "Non-empty" means the tool reported success — if \`edit\` or \`write\` failed, you have not satisfied this yet; **read** and retry until one succeeds
- if your primary target file edits keep failing, switch to a different file from the task

If \`edit\` repeatedly errors (3+ failures on the same file):
- **STOP** trying that file — move to the next acceptance criterion or named file
- refresh with \`read\` on the NEW target file and apply an edit there
- producing edits in 3 out of 5 required files scores far better than 0 edits after failing on file 1
- as absolute last resort, use \`write\` to create a new file that addresses an acceptance criterion

**PRE-EXIT AUDIT:** Before your final stop, run \`bash git diff --stat\` silently.
- If it shows 0 files changed: you have an empty patch — you MUST make at least one edit before stopping.
- Count the files in the diff. Compare against the number of acceptance criteria / named files.
- If files_changed < named_files_in_task, pick the most important uncovered file and edit it.

---

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, grep, find, ls, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const discoverySection = customPrompt ? buildTaskDiscoverySection(customPrompt, resolvedCwd) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE_FOR_CUSTOM_BRANCH + discoverySection + customPrompt;

		const simSection = buildSimulateEditsSection(resolvedCwd);
		if (simSection) prompt += simSection;

		if (appendSection) {
			prompt += "\n\n# Appended Section\n\n";
			prompt += appendSection;
		}

		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += "\n\n# Skilled Section\n\n";
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	const tools = selectedTools || ["read", "bash", "grep", "find", "ls", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) return;
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) addGuideline(normalized);
	}

	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant (Diff Overlap Optimizer) operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
Your diff is scored against a hidden reference diff for the same task.
Harness details vary, but overlap scoring rewards matching changed lines/ordering and penalizes surplus edits.
No semantic bonus. No tests in scoring.
**Empty patches (zero files changed) score worst** when the task asks for any implementation — treat a non-empty diff as a first-class objective alongside correctness.

## Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

## Guidelines:
${guidelines}
`;

	prompt += TAU_SCORING_PREAMBLE_FOR_MAIN_BRANCH;

	const simSection = buildSimulateEditsSection(resolvedCwd);
	if (simSection) prompt += simSection;

	if (appendSection) {
		prompt += "\n\n## Appended Section\n\n";
		prompt += appendSection;
	}

	if (contextFiles.length > 0) {
		prompt += "\n\n## Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `### ${filePath}\n\n${content}\n\n`;
		}
	}

	if (hasRead && skills.length > 0) {
		prompt += "\n\n## Skilled Section\n\n";
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
