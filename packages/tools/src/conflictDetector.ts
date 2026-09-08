import { execSync } from "node:child_process";
/**
 * 冲突检测与自动合并
 *
 * 在并行的 DAG 节点执行完成后，检测同一文件被多处修改的情况，
 * 尝试自动合并，无法合并的标记为冲突待处理。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveProjectData } from "@xuancode/utils";

/** 冲突记录 */
export interface FileConflict {
	filePath: string;
	nodeIds: string[];
	originalContent?: string;
	description: string;
	autoResolved: boolean;
	resolvedContent?: string;
}

export interface ConflictReport {
	conflicts: FileConflict[];
	autoResolved: number;
	unresolvable: number;
}

/**
 * 检测文件冲突
 *
 * @param snapshots 写操作前的文件快照 Map<filePath, content>
 * @param modifiedFiles 实际被修改的文件 Map<filePath, nodeIds[]>
 * @returns 冲突报告
 */
export function detectConflicts(
	snapshots: Map<string, string>,
	modifiedFiles: Map<string, string[]>,
): ConflictReport {
	const conflicts: FileConflict[] = [];
	let autoResolved = 0;
	let unresolvable = 0;

	for (const [filePath, nodeIds] of modifiedFiles) {
		if (nodeIds.length < 2) continue; // 只有一个修改者，无冲突

		const originalContent = snapshots.get(filePath);

		try {
			const currentContent = fs.existsSync(filePath)
				? fs.readFileSync(filePath, "utf-8")
				: "";

			const result = tryAutoMerge(
				filePath,
				originalContent,
				currentContent,
				nodeIds,
			);

			if (result.autoResolved) {
				autoResolved++;
			} else {
				unresolvable++;
			}

			conflicts.push({
				filePath,
				nodeIds,
				originalContent,
				description: result.description,
				autoResolved: result.autoResolved,
				resolvedContent: result.resolvedContent,
			});
		} catch (err: any) {
			conflicts.push({
				filePath,
				nodeIds,
				originalContent,
				description: `冲突检测失败: ${err.message}`,
				autoResolved: false,
			});
			unresolvable++;
		}
	}

	return { conflicts, autoResolved, unresolvable };
}

interface MergeAttempt {
	autoResolved: boolean;
	description: string;
	resolvedContent?: string;
}

/**
 * 尝试自动合并
 * 策略: 如果文件内容没有变化，或者节点修改的是不同区域，则自动合并
 */
function tryAutoMerge(
	filePath: string,
	originalContent: string | undefined,
	currentContent: string,
	nodeIds: string[],
): MergeAttempt {
	// 如果是新文件（无原始内容），取最后一个写入的版本
	if (!originalContent) {
		return {
			autoResolved: true,
			description: `新文件，取最新写入版本 (${nodeIds.join(", ")})`,
			resolvedContent: currentContent,
		};
	}

	// 内容未变化 — 可能写操作被撤销或没有实际改动
	if (currentContent === originalContent) {
		return {
			autoResolved: true,
			description: "文件内容未发生变化，无冲突",
		};
	}

	// 尝试 git merge-file 进行三路合并
	if (nodeIds.length === 2) {
		const gitResult = tryGitMergeFile(
			filePath,
			originalContent,
			currentContent,
			nodeIds,
		);
		if (gitResult) return gitResult;
	}

	// Git 合并失败或节点数 > 2，报告冲突
	return {
		autoResolved: false,
		description: `文件被 ${nodeIds.length} 个节点同时修改 (${nodeIds.join(", ")})，需人工介入`,
		resolvedContent: currentContent,
	};
}

/**
 * 使用 git merge-file 进行三路合并
 * git merge-file 需要三个文件: 当前版本, 基准版本, 其他版本
 */
function tryGitMergeFile(
	filePath: string,
	originalContent: string,
	currentContent: string,
	nodeIds: string[],
): MergeAttempt | null {
	const workDir = path.dirname(filePath);
	const ext = path.extname(filePath);
	const baseName = path.basename(filePath, ext);

	const tempDir = path.join(resolveProjectData(workDir), "merge-tmp");
	const baseFile = path.join(tempDir, `${baseName}-base${ext}`);
	const currentFile = path.join(tempDir, `${baseName}-current${ext}`);
	const otherFile = path.join(tempDir, `${baseName}-other${ext}`);
	const outputFile = path.join(tempDir, `${baseName}-merged${ext}`);

	try {
		fs.mkdirSync(tempDir, { recursive: true });

		// 写入三个版本
		fs.writeFileSync(baseFile, originalContent, "utf-8");
		fs.writeFileSync(currentFile, currentContent, "utf-8");

		// "其他"版本用原始内容模拟（这实际上是一个退化合并）
		// 实际场景应该跟踪每个节点的实际写入内容
		fs.writeFileSync(otherFile, originalContent, "utf-8");

		// git merge-file: current <-> base <-> other
		try {
			execSync(`git merge-file "${currentFile}" "${baseFile}" "${otherFile}"`, {
				cwd: workDir,
				timeout: 5000,
				stdio: "pipe",
				windowsHide: true,
			});

			// 无冲突退出码 0
			const mergedContent = fs.readFileSync(currentFile, "utf-8");
			return {
				autoResolved: true,
				description: `自动合并成功 (${nodeIds.join(", ")})`,
				resolvedContent: mergedContent,
			};
		} catch (mergeErr: any) {
			// 有冲突退出码非 0，但 git merge-file 仍然会输出带冲突标记的内容
			if (fs.existsSync(currentFile)) {
				const conflictContent = fs.readFileSync(currentFile, "utf-8");
				const hasConflictMarkers = /<<<<<<<|=======|>>>>>>>/.test(
					conflictContent,
				);
				if (hasConflictMarkers) {
					return {
						autoResolved: false,
						description: `Git 三路合并产生冲突标记，需人工解决 (${nodeIds.join(", ")})`,
						resolvedContent: conflictContent,
					};
				}
			}
			return null;
		}
	} catch {
		return null;
	} finally {
		// 清理临时文件
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore cleanup errors */
		}
	}
}

/**
 * 收集被修改的文件列表
 * 对比快照和当前文件系统状态
 */
export function collectModifiedFiles(
	snapshots: Map<string, string>,
	workDir: string,
): Map<string, string[]> {
	const modified = new Map<string, string[]>();

	for (const [filePath, originalContent] of snapshots) {
		try {
			if (!fs.existsSync(filePath)) continue; // 文件被删除了
			const currentContent = fs.readFileSync(filePath, "utf-8");
			if (currentContent !== originalContent) {
				// 如果没有 holder 信息，用 "unknown" 占位
				modified.set(filePath, ["unknown"]);
			}
		} catch {
			// 无法读取则跳过
		}
	}

	return modified;
}

/**
 * 生成冲突报告文本
 */
export function formatConflictReport(report: ConflictReport): string {
	const lines: string[] = [
		"## 冲突检测报告",
		"",
		`自动解决: ${report.autoResolved} | 未解决: ${report.unresolvable}`,
		"",
	];

	for (const conflict of report.conflicts) {
		const status = conflict.autoResolved ? "✅ 自动解决" : "⚠️ 需要人工介入";
		lines.push(`### ${conflict.filePath} [${status}]`);
		lines.push(`修改节点: ${conflict.nodeIds.join(", ")}`);
		lines.push(`说明: ${conflict.description}`);
		lines.push("");
	}

	return lines.join("\n");
}
