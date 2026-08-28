import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { ToolResult } from "@xuancode/types";
import { ALLOW_FILE_EXT, MAX_FILE_SIZE } from "./constants";
import { isIgnoreFile } from "./ignore";
import { getGlobalLockManager } from "./lockManager";
import { normalizeLongPath, resolvePath } from "./pathUtil";

/** C4 · 大文件渐进加载：无范围读取时返回的头部行数上限 */
const PROGRESSIVE_HEAD_LINES = 400;
/** 单次读取返回的字符上限（防超大范围把上下文打爆） */
const MAX_READ_CHARS = 160 * 1024;

/** Read multiple files in one tool call. Returns combined content with file headers. */
export async function readFiles(
	root: string,
	paths: string[],
	options?: { strictBoundary?: boolean },
): Promise<ToolResult> {
	const start = performance.now();
	const resolvedRoot = path.resolve(root);
	const strictBoundary = options?.strictBoundary ?? true;
	const results: string[] = [];
	const errors: string[] = [];

	for (const filePath of paths) {
		const fullPath = path.resolve(root, filePath);
		const fsPath = normalizeLongPath(fullPath);

		if (strictBoundary && !fullPath.startsWith(resolvedRoot)) {
			errors.push(`路径越权: ${filePath}`);
			continue;
		}
		if (isIgnoreFile(filePath)) {
			errors.push(`忽略: ${filePath}`);
			continue;
		}

		try {
			const stat = await fs.stat(fsPath);
			if (stat.size > MAX_FILE_SIZE) {
				// C4 · 大文件渐进头部（不再整体拒绝批量读取）
				const { lines, truncated } = await readHead(
					fsPath,
					PROGRESSIVE_HEAD_LINES,
				);
				const mb = (stat.size / 1024 / 1024).toFixed(1);
				let head = `===== ${filePath} (大文件 ${mb}MB, 已显示前 ${lines.length} 行; 请用 read_file + start_line/end_line 分块) =====\n${lines.join("\n")}`;
				if (truncated)
					head += "\n\n[已达单次输出上限，请用 read_file 分块读取]";
				results.push(head);
				continue;
			}
			const data = await fs.readFile(fsPath, "utf-8");
			results.push(`===== ${filePath} =====\n${data}`);
		} catch (e: any) {
			errors.push(`${filePath}: ${e.message}`);
		}
	}

	let combined = results.join("\n\n");
	if (errors.length > 0) {
		combined += `\n\n===== 读取失败的 ${errors.length} 个文件 =====\n${errors.join("\n")}`;
	}

	return {
		success: results.length > 0,
		data: combined,
		duration: performance.now() - start,
		error: results.length === 0 ? errors[0] : undefined,
	};
}

interface RangeRead {
	lines: string[];
	firstLine: number;
	total: number;
	totalExact: boolean;
	truncated: boolean;
}

/** 流式读取行范围 [startLine, endLine]：一次 pass 计数总行数，不把整文件载入内存。
 *  目标行全部收集后提前终止（仅当行数足够大），total 此时为下界（totalExact=false）。 */
function readLinesRange(
	fsPath: string,
	startLine: number,
	endLine: number,
): Promise<RangeRead> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(fsPath, { encoding: "utf-8" });
		const rl = readline.createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		const lines: string[] = [];
		let firstLine = 0;
		let total = 0;
		let earlyStopped = false;
		let truncated = false;
		let chars = 0;
		rl.on("line", (line) => {
			total++;
			if (total >= startLine && total <= endLine) {
				if (firstLine === 0) firstLine = total;
				chars += line.length + 1;
				if (chars > MAX_READ_CHARS) {
					truncated = true;
				} else {
					lines.push(line);
				}
			}
			// 目标行已全部收集且文件确实很大 → 提前终止（total 为下界）
			if (
				total > endLine &&
				total > 1000 &&
				(truncated || lines.length >= endLine - startLine + 1)
			) {
				earlyStopped = true;
				rl.close();
				stream.destroy();
			}
		});
		rl.on("close", () =>
			resolve({
				lines,
				firstLine,
				total,
				totalExact: !earlyStopped,
				truncated,
			}),
		);
		rl.on("error", reject);
		stream.on("error", (e: any) => {
			// 提前终止导致的预期错误（流未读完即 destroy）
			if (e?.code === "ERR_STREAM_PREMATURE_CLOSE") return;
			reject(e);
		});
	});
}

/** 流式读取文件前 maxLines 行（大文件无范围时的渐进头部） */
function readHead(
	fsPath: string,
	maxLines: number,
): Promise<{ lines: string[]; truncated: boolean }> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(fsPath, { encoding: "utf-8" });
		const rl = readline.createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		const lines: string[] = [];
		let truncated = false;
		let chars = 0;
		rl.on("line", (line) => {
			if (lines.length >= maxLines || chars >= MAX_READ_CHARS) {
				truncated = true;
				rl.close();
				stream.destroy();
				return;
			}
			chars += line.length + 1;
			lines.push(line);
		});
		rl.on("close", () => resolve({ lines, truncated }));
		rl.on("error", reject);
		stream.on("error", (e: any) => {
			if (e?.code === "ERR_STREAM_PREMATURE_CLOSE") return;
			reject(e);
		});
	});
}

export async function readFile(
	root: string,
	filePath: string,
	options?: { strictBoundary?: boolean; startLine?: number; endLine?: number },
): Promise<ToolResult> {
	const start = performance.now();
	const fullPath = path.resolve(root, filePath);
	const resolvedRoot = path.resolve(root);
	const strictBoundary = options?.strictBoundary ?? true;
	const fsPath = normalizeLongPath(fullPath);

	// Security: enforce workdir boundary (relative AND absolute paths)
	if (strictBoundary && !fullPath.startsWith(resolvedRoot)) {
		return {
			success: false,
			data: "",
			error: `路径越权: ${filePath} 不在工作目录内`,
		};
	}

	if (isIgnoreFile(filePath)) {
		return { success: false, data: "", error: "文件被忽略规则过滤" };
	}

	try {
		const stat = await fs.stat(fsPath);

		// 行范围读取：startLine/endLine 为 1 索引，含 endLine。流式按需，无大小上限
		if (options?.startLine !== undefined) {
			const startLine = Math.max(1, options.startLine);
			const endLine =
				options.endLine !== undefined
					? Math.max(startLine, options.endLine)
					: startLine;
			const { lines, firstLine, total, totalExact, truncated } =
				await readLinesRange(fsPath, startLine, endLine);
			const from = lines.length ? firstLine : Math.min(startLine, total);
			const to = from + Math.max(0, lines.length - 1);
			const totalLabel = totalExact ? total : `≥${total}`;
			let data = `===== ${filePath} (第 ${from}-${to} 行 / 共 ${totalLabel} 行) =====\n${lines.join("\n")}`;
			if (truncated)
				data += `\n\n[已达单次输出上限 ${Math.round(MAX_READ_CHARS / 1024)}KB，请缩小读取范围]`;
			return { success: true, data, duration: performance.now() - start };
		}

		// 小文件：整文件读取（原行为）
		if (stat.size <= MAX_FILE_SIZE) {
			const data = await fs.readFile(fsPath, "utf-8");
			return { success: true, data, duration: performance.now() - start };
		}

		// C4 · 大文件渐进头部：不再硬拒，返回前 N 行并提示用 start_line/end_line 分块
		const { lines, truncated } = await readHead(fsPath, PROGRESSIVE_HEAD_LINES);
		const mb = (stat.size / 1024 / 1024).toFixed(1);
		let data = `===== ${filePath} (共 ≥${lines.length} 行, ${mb}MB, 已显示前 ${lines.length} 行; 大文件请用 start_line/end_line 分块读取) =====\n${lines.join("\n")}`;
		if (truncated)
			data += "\n\n[已达单次输出上限，请用 start_line/end_line 继续读取]";
		return { success: true, data, duration: performance.now() - start };
	} catch (e: any) {
		return {
			success: false,
			data: "",
			error: e.message,
			duration: performance.now() - start,
		};
	}
}

export async function writeFile(
	root: string,
	filePath: string,
	content: string,
	options?: { strictBoundary?: boolean; holderId?: string },
): Promise<ToolResult> {
	const start = performance.now();
	const fullPath = path.resolve(root, filePath);
	const resolvedRoot = path.resolve(root);
	const strictBoundary = options?.strictBoundary ?? true;
	const fsPath = normalizeLongPath(fullPath);

	// Security: enforce workdir boundary (relative AND absolute paths)
	if (strictBoundary && !fullPath.startsWith(resolvedRoot)) {
		return {
			success: false,
			data: "",
			error: `路径越权: ${filePath} 不在工作目录内`,
		};
	}

	if (isIgnoreFile(filePath)) {
		return { success: false, data: "", error: "文件被忽略规则过滤" };
	}

	// Phase 3: 排他写锁检查
	const holderId = options?.holderId || "main-agent";
	const lockMgr = getGlobalLockManager();
	if (lockMgr.isLocked(fullPath)) {
		const holder = lockMgr.getLockHolder(fullPath);
		if (holder && holder.holderId !== holderId) {
			return {
				success: false,
				data: "",
				error: `文件被其他 Agent 锁定: ${filePath} (锁定者: ${holder.holderLabel})。请等待其完成后再重试。`,
				duration: performance.now() - start,
			};
		}
	}

	try {
		await fs.mkdir(path.dirname(fsPath), { recursive: true });
		await fs.writeFile(fsPath, content, "utf-8");
		return {
			success: true,
			data: `写入成功: ${filePath}`,
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
