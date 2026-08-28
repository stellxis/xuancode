import type { LintResult } from "./types";
import { LANGUAGE_MAP } from "./types";

export function lintFile(filePath: string, content: string): LintResult[] {
	const results: LintResult[] = [];
	const ext = filePath.split(".").pop() || "";
	const lang = LANGUAGE_MAP[ext] || "";
	const lines = content.split("\n");

	if (lang === "typescript" || lang === "javascript") {
		const importLines: { line: number; name: string }[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const importMatch = line.match(
				/import\s+(?:\*\s+as\s+)?(\w+|\{[^}]+\})\s+from\s+["']([^"']+)["']/,
			);
			if (importMatch) {
				importLines.push({ line: i, name: importMatch[1] });
			}
		}

		for (const imp of importLines) {
			const importName = imp.name.replace(/[{}]/g, "").trim();
			const name = importName.split(" as ").pop()?.trim() || importName;
			if (name && name !== "*") {
				const used = lines.some(
					(l, idx) => idx !== imp.line && l.includes(name),
				);
				if (!used) {
					results.push({
						filePath,
						line: imp.line,
						column: 0,
						severity: "warning",
						message: `未使用的导入: "${name}"`,
						rule: "no-unused-import",
					});
				}
			}
		}

		for (let i = 0; i < lines.length; i++) {
			const anyMatch = lines[i].match(/\bany\b/);
			if (anyMatch) {
				results.push({
					filePath,
					line: i,
					column: anyMatch.index || 0,
					severity: "warning",
					message: "使用 'any' 类型会绕过类型检查",
					rule: "no-any",
				});
			}
		}
	}

	return results;
}
