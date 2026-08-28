import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolResult } from "@xuancode/types";
import { MAX_GLOB_FILES } from "./constants";
import { isIgnoreFile } from "./ignore";
import { normalizeLongPath } from "./pathUtil";

export async function globFiles(
	root: string,
	pattern: string,
): Promise<ToolResult> {
	const start = performance.now();

	try {
		// Simple recursive glob implementation
		const results: string[] = [];
		const parts = pattern.split("/");
		const hasRecursive = parts.includes("**");

		async function walk(dir: string, relative: string, depth: number) {
			if (results.length >= MAX_GLOB_FILES) return;
			if (depth > 10) return;

			let entries: Dirent[];
			try {
				entries = await fs.readdir(normalizeLongPath(dir), {
					withFileTypes: true,
				});
			} catch {
				return;
			}

			for (const entry of entries) {
				const relPath = relative ? `${relative}/${entry.name}` : entry.name;
				if (isIgnoreFile(relPath)) continue;

				if (entry.isDirectory()) {
					if (hasRecursive) {
						await walk(path.join(dir, entry.name), relPath, depth + 1);
					}
				} else if (!hasRecursive || matchGlob(relPath, pattern)) {
					results.push(relPath);
				}
			}
		}

		await walk(root, "", 0);

		return {
			success: true,
			data: results.slice(0, MAX_GLOB_FILES).join("\n"),
			duration: performance.now() - start,
		};
	} catch (e: any) {
		return {
			success: false,
			data: "",
			error: e.message,
			duration: performance.now() - start,
		};
	}
}

function matchGlob(filePath: string, pattern: string): boolean {
	const regexStr = pattern
		.replace(/\./g, "\\.")
		.replace(/\*\*/g, "::recursive::")
		.replace(/\*/g, "[^/]*")
		.replace(/::recursive::/g, ".*");
	return new RegExp(`^${regexStr}$`).test(filePath);
}
