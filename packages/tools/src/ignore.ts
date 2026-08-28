import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";

let ignoreInstance: ReturnType<typeof ignore>;

export function initIgnore(cwd: string): void {
	const ig = ignore();
	const files = [".aiignore", ".gitignore"];

	for (const file of files) {
		const p = path.join(cwd, file);
		if (fs.existsSync(p)) {
			ig.add(fs.readFileSync(p, "utf-8"));
		}
	}

	ig.add([
		"node_modules/",
		"dist/",
		"build/",
		".venv/",
		"__pycache__/",
		".git/",
	]);
	ignoreInstance = ig;
}

export function isIgnoreFile(filePath: string): boolean {
	return ignoreInstance?.ignores(filePath) ?? false;
}

export function getIgnoreInstance() {
	return ignoreInstance;
}
