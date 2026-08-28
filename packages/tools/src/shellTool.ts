import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "@xuancode/types";
import { execa } from "execa";
import { MAX_SHELL_TIMEOUT, SHELL_DANGER_LIST } from "./constants";
import { normalizeLongPath } from "./pathUtil";

/**
 * Decode a buffer from a child process, accounting for Windows Chinese encoding (GBK).
 * On Chinese Windows, process output often uses code page 936 (GBK) instead of UTF-8.
 * execa v9 returns Uint8Array for `encoding: "buffer"`, so normalize to Buffer first.
 */
function decodeProcessBuffer(buf: Buffer | Uint8Array): string {
	const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	if (process.platform !== "win32") return asBuffer.toString("utf-8");
	// Try UTF-8 first (modern tools like tsc via Node may output UTF-8)
	const utf8 = asBuffer.toString("utf-8");
	// Replacement character � indicates invalid UTF-8 byte sequences → likely GBK
	if (!utf8.includes("�")) return utf8;
	// Fall back to GBK (Windows code page 936 / Chinese)
	try {
		return new TextDecoder("gbk", { fatal: false }).decode(asBuffer);
	} catch {
		return utf8;
	}
}

// ===== Git Bash 探测（Windows） =====
// cmd.exe 缺少 sed/wc/ls 等 Unix 命令，优先使用 Git Bash 执行通用命令。

const GIT_BASH_CANDIDATES: Array<() => string> = [
	() =>
		path.join(
			process.env.ProgramFiles || "C:\\Program Files",
			"Git",
			"bin",
			"bash.exe",
		),
	() =>
		path.join(
			process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
			"Git",
			"bin",
			"bash.exe",
		),
	() =>
		path.join(
			process.env.LOCALAPPDATA || "",
			"Programs",
			"Git",
			"bin",
			"bash.exe",
		),
	() => "/usr/bin/bash",
];

function detectShell(command: string): string | boolean {
	if (process.platform !== "win32") return true;
	const trimmed = command.trim();
	if (!trimmed) return true;

	// cmd.exe 原生语法：cd /d（/d 是 cmd 专属 flag）、纯 cmd 内建命令
	if (/^cd\s+\/d\b/i.test(trimmed)) return process.env.ComSpec || "cmd.exe";
	const firstWord = (trimmed.split(/[\s&|;]/)[0] || "").toLowerCase();
	if (
		/^(dir|copy|del|ren|move|type|cls|color|title|ver|attrib|findstr|fc|xcopy|robocopy|md|rd|mkdir|rmdir)$/.test(
			firstWord,
		)
	) {
		return process.env.ComSpec || "cmd.exe";
	}

	// Unix 风格构造：/e/ 驱动器路径、/dev/null 重定向
	const hasUnixPath = /(^|\s)(["']?)\/[A-Za-z0-9_]+\//.test(trimmed);
	const hasUnixRedir = /2>\s*\/dev\/null|\b\/dev\/null\b/.test(trimmed);
	// 复合命令（&& / || / | / ;）或 cd 开头 → 需要 Unix shell 语义
	const hasCompound = /&&|\|\||\||;/.test(trimmed);
	const startsWithCd = /^cd\b/.test(trimmed);

	// 简单独立 npm/pnpm 等 .cmd 脚本命令（无复合 / 无 cd / 无 Unix 构造）→ cmd.exe
	if (!hasCompound && !startsWithCd && !hasUnixPath && !hasUnixRedir) {
		if (
			/\b(npm|pnpm|yarn|npx|tsc|node|vitest|jest|mocha|vite)\b/.test(command)
		) {
			return process.env.ComSpec || "cmd.exe";
		}
	}

	// 其余（含 npm 的复合命令 / cd 开头 / Unix 路径）→ Git Bash；
	// Git Bash 下 npm/pnpm 同样可用，且原生支持 /e/ 路径、管道、2>/dev/null
	for (const getCandidate of GIT_BASH_CANDIDATES) {
		try {
			const candidate = getCandidate();
			if (candidate && fs.existsSync(candidate)) return candidate;
		} catch {
			/* skip */
		}
	}
	return process.env.ComSpec || "cmd.exe";
}

// ===== 原生文件读取 shim =====
// 拦截纯文件读取命令（sed -n / head / tail / wc -l），用 fs 直接读取，
// 避免 Windows 下缺少 Unix 命令导致退出码非 0。只在无管道/重定向的单命令形式下生效。

type NativeReadOp =
	| { kind: "range"; start: number; end: number | "$" }
	| { kind: "single"; start: number }
	| { kind: "head"; n: number }
	| { kind: "tail"; n: number }
	| { kind: "count" };

function stripQuotes(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"'))
		return t.slice(1, -1);
	if (t.length >= 2 && t.startsWith("'") && t.endsWith("'"))
		return t.slice(1, -1);
	return t;
}

function parseNativeReadCommand(
	trimmed: string,
): { file: string; op: NativeReadOp } | null {
	// sed -n '1,120p' file / sed -n 1,120p file / sed -n "2,$p" file
	let m = trimmed.match(/^sed\s+-n\s+(['"]?)(\d+),(\d+|\$)\s*p\1\s+(.+)$/);
	if (m)
		return {
			file: stripQuotes(m[4]),
			op: {
				kind: "range",
				start: Number(m[2]),
				end: m[3] === "$" ? "$" : Number(m[3]),
			},
		};
	// sed -n '5p' file
	m = trimmed.match(/^sed\s+-n\s+(['"]?)(\d+)\s*p\1\s+(.+)$/);
	if (m)
		return {
			file: stripQuotes(m[3]),
			op: { kind: "single", start: Number(m[2]) },
		};
	// head -n 10 file
	m = trimmed.match(/^head\s+-n\s+(\d+)\s+(.+)$/);
	if (m)
		return { file: stripQuotes(m[2]), op: { kind: "head", n: Number(m[1]) } };
	// tail -n 10 file
	m = trimmed.match(/^tail\s+-n\s+(\d+)\s+(.+)$/);
	if (m)
		return { file: stripQuotes(m[2]), op: { kind: "tail", n: Number(m[1]) } };
	// wc -l file
	m = trimmed.match(/^wc\s+-l\s+(.+)$/);
	if (m) return { file: stripQuotes(m[1]), op: { kind: "count" } };
	return null;
}

function tryNativeFileRead(cwd: string, command: string): ToolResult | null {
	const start = performance.now();
	const trimmed = command.trim();
	if (!trimmed) return null;
	// 含管道/重定向/逻辑连接符 → 不拦截，交给 shell 执行
	if (/[|;&<>]/.test(trimmed)) return null;

	const parsed = parseNativeReadCommand(trimmed);
	if (!parsed) return null;

	const fullPath = path.resolve(cwd, parsed.file);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(fullPath);
	} catch {
		return {
			success: false,
			data: "",
			error: `${parsed.file}: No such file or directory`,
			duration: performance.now() - start,
		};
	}
	if (!stat.isFile()) {
		return {
			success: false,
			data: "",
			error: `${parsed.file}: Is a directory`,
			duration: performance.now() - start,
		};
	}

	let content: string;
	try {
		content = fs.readFileSync(fullPath, "utf-8");
	} catch (e: any) {
		return {
			success: false,
			data: "",
			error: `${parsed.file}: ${e.message}`,
			duration: performance.now() - start,
		};
	}

	const lines = content.split(/\r?\n/);
	const total = lines.length;
	let output: string;

	switch (parsed.op.kind) {
		case "count":
			output = String(total);
			break;
		case "head":
			output = lines.slice(0, parsed.op.n).join("\n");
			break;
		case "tail":
			output = lines.slice(-parsed.op.n).join("\n");
			break;
		case "range": {
			const end = parsed.op.end === "$" ? total : parsed.op.end;
			output = lines.slice(parsed.op.start - 1, end).join("\n");
			break;
		}
		case "single": {
			const from = parsed.op.start;
			output = lines.slice(from - 1, from).join("\n");
			break;
		}
		default:
			output = lines.join("\n");
	}

	return { success: true, data: output, duration: performance.now() - start };
}

export async function runShell(
	cwd: string,
	command: string,
): Promise<ToolResult> {
	const start = performance.now();
	const lowerCmd = command.toLowerCase().trim();

	// Danger command check
	for (const danger of SHELL_DANGER_LIST) {
		if (lowerCmd.includes(danger)) {
			return {
				success: false,
				data: "",
				error: `五行 · 火: 拦截高危命令 [${danger}]`,
				duration: performance.now() - start,
			};
		}
	}

	// 原生文件读取 shim（所有平台生效）：拦截纯读取命令，避免 Windows 缺少 Unix 命令
	const native = tryNativeFileRead(cwd, command);
	if (native) return native;

	// Windows 上 npm/pnpm 等脚本需要 cmd.exe；通用命令优先 Git Bash
	const shell = detectShell(command);
	const shellCwd = normalizeLongPath(cwd);

	try {
		const res = await execa(command, {
			cwd: shellCwd,
			shell,
			timeout: MAX_SHELL_TIMEOUT,
			reject: false,
			// 允许较大的输出缓冲；防止 pnpm/tsc 输出过长导致管道断裂
			maxBuffer: 20 * 1024 * 1024,
			encoding: "buffer",
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
		});

		const stdout = decodeProcessBuffer(res.stdout || Buffer.from(""));
		const stderr = decodeProcessBuffer(res.stderr || Buffer.from(""));
		const combined =
			(stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim() || "(无输出)";

		// 非零退出码也返回具体输出，让模型能据此判断
		return {
			success: res.exitCode === 0,
			data: combined,
			error: res.exitCode === 0 ? undefined : `退出码 ${res.exitCode}`,
			duration: performance.now() - start,
		};
	} catch (e: any) {
		// 启动失败（命令未找到等）：包含 stderr 内容供模型诊断
		const stderr = e.stderr ? `\n${e.stderr}` : "";
		return {
			success: false,
			data: "",
			error: `${e.message}${stderr}`,
			duration: performance.now() - start,
		};
	}
}
