import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolResult } from "@xuancode/types";
import { isIgnoreFile } from "./ignore";
import { normalizeLongPath } from "./pathUtil";

export async function grepFiles(
	root: string,
	pattern: string,
	glob?: string,
): Promise<ToolResult> {
	const start = performance.now();

	try {
		const results: string[] = [];
		const regex = new RegExp(pattern, "i");

		async function walk(dir: string, relative: string) {
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
					if (entry.name.startsWith(".")) continue;
					await walk(path.join(dir, entry.name), relPath);
				} else if (entry.isFile()) {
					if (glob && !relPath.endsWith(glob.replace("*", ""))) continue;

					try {
						const content = await fs.readFile(
							normalizeLongPath(path.join(dir, entry.name)),
							"utf-8",
						);
						const lines = content.split("\n");
						for (let i = 0; i < lines.length; i++) {
							if (regex.test(lines[i])) {
								results.push(
									`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 120)}`,
								);
							}
						}
					} catch {
						// skip binary files
					}
				}
			}
		}

		await walk(root, "");
		return {
			success: true,
			data: results.slice(0, 200).join("\n") || "(无匹配)",
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
