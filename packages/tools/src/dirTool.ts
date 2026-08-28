import fs from "node:fs/promises";
import path from "node:path";
import type { ToolResult } from "@xuancode/types";
import { isIgnoreFile } from "./ignore";
import { normalizeLongPath } from "./pathUtil";

export async function listDir(
	root: string,
	dirPath: string,
): Promise<ToolResult> {
	const start = performance.now();
	const fullPath = path.resolve(root, dirPath);
	const resolvedRoot = path.resolve(root);
	const fsPath = normalizeLongPath(fullPath);

	// Security: enforce workdir boundary (relative AND absolute paths)
	if (!fullPath.startsWith(resolvedRoot)) {
		return {
			success: false,
			data: "",
			error: `路径越权: ${dirPath} 不在工作目录内`,
		};
	}

	try {
		const entries = await fs.readdir(fsPath, { withFileTypes: true });
		let fileCount = 0;
		let dirCount = 0;
		const lines: string[] = [];

		for (const entry of entries) {
			const relativePath = path.join(dirPath, entry.name);
			if (isIgnoreFile(relativePath)) continue;

			if (entry.isDirectory()) {
				dirCount++;
				lines.push(`  📁  ${entry.name}/`);
			} else {
				fileCount++;
				lines.push(`  📄  ${entry.name}`);
			}
		}

		const summary = `📂 ${dirPath} (${dirCount} 目录, ${fileCount} 文件)`;
		return {
			success: true,
			data: [summary, ...lines].join("\n"),
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
