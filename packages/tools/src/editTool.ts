/**
 * edit_file — 精准文本替换工具
 *
 * 在文件中查找 old_string 并替换为 new_string。
 * 相比 write_file 全量重写，edit_file 适合局部修改。
 * 定位策略: 精确匹配 old_string，如果唯一则直接替换，否则报错。
 * 行尾兼容：自动将 CRLF 与 LF 统一后匹配，避免 Windows 下编辑失败。
 */
import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "@xuancode/types";
import { isIgnoreFile } from "./ignore";
import { getGlobalLockManager } from "./lockManager";
import { normalizeLongPath } from "./pathUtil";

/** 将换行统一为 LF 以便跨平台匹配 */
function normalizeLf(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export async function editFile(
	workDir: string,
	filePath: string,
	oldString: string,
	newString: string,
	options?: { replaceAll?: boolean; holderId?: string },
): Promise<ToolResult> {
	const startTime = performance.now();

	// 路径安全检查
	const resolvedPath = path.resolve(workDir, filePath);
	const fsPath = normalizeLongPath(resolvedPath);
	if (!resolvedPath.startsWith(path.resolve(workDir))) {
		return {
			success: false,
			data: "",
			error: "路径越权",
			duration: performance.now() - startTime,
		};
	}

	// 忽略文件检查
	if (isIgnoreFile(filePath)) {
		return {
			success: false,
			data: "",
			error: `跳过忽略文件: ${filePath}`,
			duration: performance.now() - startTime,
		};
	}

	// Phase 3: 排他写锁检查
	const holderId = options?.holderId || "main-agent";
	const lockMgr = getGlobalLockManager();
	if (lockMgr.isLocked(resolvedPath)) {
		const holder = lockMgr.getLockHolder(resolvedPath);
		if (holder && holder.holderId !== holderId) {
			return {
				success: false,
				data: "",
				error: `文件被其他 Agent 锁定: ${filePath} (锁定者: ${holder.holderLabel})。请等待其完成后再重试。`,
				duration: performance.now() - startTime,
			};
		}
	}

	// 读取文件
	let content: string;
	try {
		content = fs.readFileSync(fsPath, "utf-8");
	} catch (err: any) {
		return {
			success: false,
			data: "",
			error: `文件读取失败: ${err.message}`,
			duration: performance.now() - startTime,
		};
	}

	// 行尾归一化匹配（Windows 下文件常为 CRLF，模型常输出 LF）
	const contentN = normalizeLf(content);
	const oldN = normalizeLf(oldString);
	const newN = normalizeLf(newString);

	const index = contentN.indexOf(oldN);
	if (index === -1) {
		return {
			success: false,
			data: "",
			error:
				"文件中未找到匹配的文本。请确保 old_string 与文件中的内容完全一致（包括空格和换行）。提示：行尾已自动归一化，但仍未匹配，可能是缩进或字符差异。",
			duration: performance.now() - startTime,
		};
	}

	// 检查是否唯一
	if (!options?.replaceAll) {
		const secondIndex = contentN.indexOf(oldN, index + 1);
		if (secondIndex !== -1) {
			return {
				success: false,
				data: "",
				error: "文本出现多次，请提供更多上下文以确保唯一匹配。",
				duration: performance.now() - startTime,
			};
		}
	}

	// 执行替换（在归一化后的内容上）
	const newContentN = options?.replaceAll
		? contentN.split(oldN).join(newN)
		: contentN.slice(0, index) + newN + contentN.slice(index + oldN.length);

	// 若原文件为 CRLF，则将结果转回 CRLF
	const isCrlf = /\r\n/.test(content);
	const finalContent = isCrlf
		? newContentN.replace(/\n/g, "\r\n")
		: newContentN;

	try {
		// 先写入临时文件验证
		const tmpPath = `${fsPath}.tmp`;
		fs.writeFileSync(tmpPath, finalContent, "utf-8");
		fs.renameSync(tmpPath, fsPath);
	} catch (err: any) {
		return {
			success: false,
			data: "",
			error: `文件写入失败: ${err.message}`,
			duration: performance.now() - startTime,
		};
	}

	return {
		success: true,
		data: "已替换 1 处内容",
		duration: performance.now() - startTime,
	};
}
