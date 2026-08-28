/**
 * 程序化验证 gate 工具
 *
 * 把「验证」从提示词级升级为机制级：
 * - isVerifyCommand: 识别 shell 命令是否为验证类命令（编译/测试/静态检查）
 * - extractVerifyErrors: 从输出提取关键错误行（错误关键字 + file:line 位置）
 * - evaluateVerifyGate: 判定是否允许模型结束任务（未验证通过则拦截）
 */
import type { CheckpointVerifyState } from "./projectCheckpoint";

/** 判断命令是否为验证类命令（编译/测试/静态检查/git 验证导向命令）。返回 true 表示该命令可证明改动正确性。 */
export function isVerifyCommand(cmd: string): boolean {
	const c = cmd.toLowerCase().trim();
	if (!c) return false;

	// 常用编译/测试/检查命令（命令级，独立出现）
	if (
		/(^|\s)(tsc(\s+--\S+)*|tsup|webpack|rollup|esbuild|vite\s+build|makepkg|cmake|make|gcc|g\+\+|clang|cargo\s+(build|check|test)|go\s+(build|test)|dotnet\s+(build|test)|mvn\s+(compile|test|package)|gradlew?\s+(build|test)|pytest|jest|vitest|mocha|cypress\s+run|playwright\s+test|eslint|tslint)(\s|$)/.test(
			c,
		)
	)
		return true;

	// npm/pnpm/yarn/npx 的验证脚本
	if (
		/(npm|pnpm|yarn|npx|bun)(\s+run)?\s+(build|test|lint|typecheck|type-check|check|compile|validate)\b/.test(
			c,
		)
	)
		return true;

	// 单独出现的快捷验证命令
	if (/^(\s*)(npm|pnpm|yarn|npx|bun)\s+(test|lint|check)\b/.test(c))
		return true;
	if (/^prettier\s+--check\b/.test(c)) return true;

	// git 验证导向命令：配置/仓库类任务（.gitignore、文件忽略规则、提交前检查）没有编译/测试步骤，
	// git 状态/差异/忽略检查是它们的自然验证方式。只识别「验证导向」子命令——
	// 纯 `git status` / `git log` 这类信息性命令不视为验证（否则写码任务随便跑一次 status 就绕过 gate）。
	if (
		/\bgit\s+(?:check-ignore\b|diff\s+(?:--cached\s+)?--check\b|diff\s+(?:--cached\s+)?--exit-code\b|status\s+(?:--porcelain|-s)\b|ls-files\s+--(?:error-unmatch|others\s+--ignored\s+--exclude-standard)\b)/.test(
			c,
		)
	) {
		return true;
	}

	return false;
}

/** 错误行判定：错误关键字 或 file:line:col 位置模式 */
function isCompileErrorLine(t: string): boolean {
	return (
		/(error|Error|ERROR|✗|✖|FAILED|failed|failure|exception|Exception|✘|cannot\s+find|找不到|cannot\s+resolve|SyntaxError|TypeError|ReferenceError|TS\d{3,5}|\bE\d{4}\b)/.test(
			t,
		) || /\.\w{1,8}:\d+(:\d+)?(\s|$)/.test(t)
	);
}

/** 从输出提取去重后的关键错误行，最多 max 行（供 gate 提示与编译截断复用） */
function extractErrorLines(output: string, max: number): string[] {
	const lines = output.split(/\r?\n/);
	const seen = new Set<string>();
	const picked: string[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		if (isCompileErrorLine(t) && !seen.has(t)) {
			seen.add(t);
			picked.push(t);
			if (picked.length >= max) break;
		}
	}
	return picked;
}

/** 尾部摘要/统计行（如 "Found 2 errors." / "Tests: 3 passed" / "Build FAILED"），最多 max 行 */
function extractTailSummary(output: string, max: number): string[] {
	const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);
	const SUMMARY_RE =
		/(found\s+\d+\s+errors?|problems?\b|tests?:?\s*$|suites?:?\s|passed\s|failed\s|failures?\s|error\s+ts\d|build\s+(failed|succeeded|success)|compiled\s+successfully|done\s+in|elapsed|exit\s+code|process\s+exited)/i;
	const picked: string[] = [];
	for (let i = lines.length - 1; i >= 0 && picked.length < max; i--) {
		const t = lines[i].trim();
		if (SUMMARY_RE.test(t)) picked.unshift(t);
	}
	return picked;
}

/** 通用头尾截断（编译截断的非编译输出兜底） */
function defaultTruncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.5);
	const tail = max - head - 40;
	return `${text.slice(0, head)}\n...(省略 ${text.length - max + 40} 字符)...\n${text.slice(-tail)}`;
}

/**
 * 从验证输出提取关键错误行（错误关键字 + file:line 位置），去重后最多 max 行。
 * 编译器通常把「文件:行:列 - error TSxxxx」逐行输出，逐行匹配可保住可修复的错误点。
 */
export function extractVerifyErrors(output: string, max = 12): string {
	if (!output) return "";
	const picked = extractErrorLines(output, max);
	if (picked.length > 0) return picked.join("\n");
	// 兜底：取末尾几行（编译/测试工具通常把摘要放在最后）
	const lines = output.split(/\r?\n/);
	return lines.slice(-Math.min(max, lines.length)).join("\n");
}

/**
 * 编译/测试输出专用截断。
 * 识别到编译器/测试输出特征时，优先保留可修复的错误行与尾部摘要，丢弃中间噪声；
 * 非编译输出时调用 fallback（默认通用头尾截断）保证行为与通用截断一致。
 */
export function truncateCompileOutput(
	output: string | undefined,
	max: number,
	fallback: (o: string, m: number) => string = defaultTruncate,
): string {
	if (!output) return "";
	if (output.length <= max) return output;

	const errLines = extractErrorLines(output, 30);
	const tailLines = extractTailSummary(output, 8);

	// 编译输出特征：有结构化错误行，或尾部带测试/构建摘要
	if (errLines.length === 0 && tailLines.length === 0) {
		return fallback(output, max);
	}

	const seen = new Set<string>();
	const keep: string[] = [];
	let used = 0;
	for (const line of [...errLines, ...tailLines]) {
		if (seen.has(line)) continue;
		if (used + line.length + 2 > max) break;
		seen.add(line);
		keep.push(line);
		used += line.length + 2;
	}

	// 关键行太少（占比不足 30%）时退回通用截断，避免只保留一两行的信息裸奔
	if (used < max * 0.3) return fallback(output, max);

	return `[编译输出 ${output.length} 字符 → ${used} 字符关键行]\n${keep.join("\n")}`;
}

/** 验证 gate 判定结果 */
export interface VerifyGateDecision {
	block: boolean;
	message: string;
}

/**
 * 评估验证 gate：在模型试图「无工具直接结束」时决定是否拦截。
 * 拦截条件（缺一不可）：
 *   - mode === "auto"
 *   - 已修改代码（modified > 0）
 *   - 未记录到验证通过
 *   - 拦截次数未超上限（避免死循环）
 */
export function evaluateVerifyGate(opts: {
	mode: "auto" | "manual" | "off";
	modified: number;
	verify: CheckpointVerifyState;
	command?: string;
	maxFixRounds: number;
	gateBlocks: number;
}): VerifyGateDecision {
	if (opts.mode !== "auto") return { block: false, message: "" };
	if (opts.modified === 0) return { block: false, message: "" };
	if (opts.verify.passed) return { block: false, message: "" };
	if (opts.gateBlocks >= opts.maxFixRounds + 2)
		return { block: false, message: "" };

	const cmdHint = opts.command
		? `执行 \`${opts.command}\``
		: "执行合适的测试/构建/lint 命令";

	if (!opts.verify.ran) {
		return {
			block: true,
			message: `(⚠️ 验证 gate：代码已修改但尚未验证。完成任务前，请先 ${cmdHint} 验证改动；若失败，根据错误修复后重新验证，直到通过再总结。)`,
		};
	}

	// 已运行验证但失败 → 附带提取的关键错误，帮助模型即使输出被截断也能看到错误点
	const errs = opts.verify.lastOutput
		? extractVerifyErrors(opts.verify.lastOutput, 8)
		: "";
	const errSection = errs ? `\n关键错误：\n${errs}\n` : "\n";
	return {
		block: true,
		message: `(⚠️ 验证 gate：验证仍未通过（已尝试 ${opts.verify.rounds} 次）。${errSection}请修复后重新 ${cmdHint} 验证，不要直接结束任务。)`,
	};
}
