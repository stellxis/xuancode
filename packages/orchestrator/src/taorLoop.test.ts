import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	type Message,
	type ModelAdapter,
	type NativeToolCall,
	StopReason,
	type ToolCallsStreamEvent,
} from "@xuancode/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTaorLoop } from "./taorLoop";

const TEST_DIR = path.join(process.cwd(), ".test-taortmp");

/** A controllable mock model for testing TAOR loop behavior */
class ControllableMockAdapter implements ModelAdapter {
	readonly provider: string;
	readonly modelName: string;
	public lastSystemPrompt = "";
	private responses: string[];
	private callIndex = 0;
	public simulateError = false;
	public simulateEmptyResponse = false;
	/** M3 富结构：每轮可选的结构化原生工具调用事件（与 responses 按轮对齐） */
	public structuredToolCalls: (NativeToolCall[] | null)[] = [];

	constructor(responses: string[], opts: { provider?: string } = {}) {
		this.responses = responses;
		this.provider = opts.provider || "test-mock";
		this.modelName = this.provider;
	}

	async chat(_messages: Message[], systemPrompt?: string): Promise<string> {
		this.lastSystemPrompt = systemPrompt || "";
		if (this.simulateError) {
			this.simulateError = false;
			throw new Error("模拟模型 API 错误");
		}
		if (this.simulateEmptyResponse) {
			this.simulateEmptyResponse = false;
			return "";
		}
		const response =
			this.responses[this.callIndex] ||
			this.responses[this.responses.length - 1];
		this.callIndex++;
		return response;
	}

	async *chatStream(
		_messages: Message[],
		systemPrompt?: string,
	): AsyncGenerator<string | ToolCallsStreamEvent, void, unknown> {
		this.lastSystemPrompt = systemPrompt || "";
		const response =
			this.responses[this.callIndex] ||
			this.responses[this.responses.length - 1];
		const idx = this.callIndex;
		this.callIndex++;
		yield response;
		// M3 富结构：文本后追加结构化工具调用事件（阵营 B 原生通道）
		const tc = this.structuredToolCalls[idx];
		if (tc && tc.length > 0) yield { type: "tool_calls", toolCalls: tc };
	}
}

describe("TAOR loop integration", () => {
	beforeAll(() => {
		if (fs.existsSync(TEST_DIR))
			fs.rmSync(TEST_DIR, { recursive: true, force: true });
		fs.mkdirSync(TEST_DIR, { recursive: true });
		execSync("git init", { cwd: TEST_DIR, encoding: "utf-8" });
		// CI 干净环境没有全局 git 身份,设置仓库本地身份保证 commit 可执行
		execSync(
			'git config user.email "test@xuancode.local" && git config user.name "xuancode-test"',
			{
				cwd: TEST_DIR,
				encoding: "utf-8",
			},
		);
		fs.writeFileSync(path.join(TEST_DIR, "test.ts"), "const x = 1;\n");
		execSync("git add -A && git commit -m 'init'", {
			cwd: TEST_DIR,
			encoding: "utf-8",
		});
	});

	afterAll(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("should complete a multi-turn tool call workflow", async () => {
		const model = new ControllableMockAdapter([
			// Turn 1: model calls list_dir
			JSON.stringify({ type: "list_dir", path: "." }),
			// Turn 2: model responds directly (completion)
			"已完成。项目根目录包含一个 TypeScript 文件和一个 Git 仓库。",
		]);

		const result = await runTaorLoop("查看项目目录结构", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.turnCount).toBeGreaterThanOrEqual(1);
		expect(result.toolCallCount).toBe(1);
		expect(result.errorCount).toBe(0);
		expect(result.finalAnswer).toContain("已完成");
	});

	it("should handle model API errors via continue site recovery", async () => {
		const model = new ControllableMockAdapter([
			"重试后的正常响应，无需工具调用。",
		]);
		model.simulateError = true; // First call will fail

		const result = await runTaorLoop("测试错误恢复", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.turnCount).toBeGreaterThanOrEqual(1);
	});

	it("should stop at max turns", async () => {
		// Model always returns a tool call — will hit max turns
		const model = new ControllableMockAdapter(
			Array(20).fill(JSON.stringify({ type: "list_dir", path: "." })),
		);

		const result = await runTaorLoop("循环任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 3 },
		});

		expect(result.stopReason).toBe(StopReason.MAX_TURNS);
		expect(result.turnCount).toBe(3);
		expect(result.toolCallCount).toBe(2); // Stop fires before model call, so only 2 tools executed
	});

	it("should auto-continue past max turns when maxContinuations set", async () => {
		// [tool, tool, "完成"] with maxTurns=3 + 1 continuation → completes at turn 4
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "list_dir", path: "." }),
			JSON.stringify({ type: "list_dir", path: "." }),
			"完成。",
		]);

		const result = await runTaorLoop("续跑任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 3, maxContinuations: 1 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.turnCount).toBe(4);
	});

	it("should keep backward-compat: without maxContinuations, stop at max turns", async () => {
		const model = new ControllableMockAdapter(
			Array(20).fill(JSON.stringify({ type: "list_dir", path: "." })),
		);

		const result = await runTaorLoop("无续跑任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 3 }, // maxContinuations 缺省 → 0
		});

		expect(result.stopReason).toBe(StopReason.MAX_TURNS);
		expect(result.turnCount).toBe(3);
	});

	it("should inject turn budget warning near 75% of max turns", async () => {
		// V5: use 4 distinct calls so loop detection doesn't fire before the warning
		const calls = [
			JSON.stringify({ type: "list_dir", path: "." }),
			JSON.stringify({ type: "list_dir", path: "src" }),
			JSON.stringify({ type: "glob", pattern: "**/*.ts" }),
			JSON.stringify({ type: "grep", pattern: "TODO" }),
		];
		const model = new ControllableMockAdapter(calls);
		const warned: string[] = [];

		const result = await runTaorLoop("预警任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 4 }, // warnThreshold = floor(4*0.75) = 3
			onTurn: (_turn, state) => {
				for (const m of (state as any)?.messages || []) {
					if (
						typeof m.content === "string" &&
						m.content.includes("请评估剩余工作量")
					) {
						warned.push(m.content);
					}
				}
			},
		});

		expect(warned.length).toBeGreaterThanOrEqual(1);
		expect(warned[0]).toContain("已使用 3/4 轮");
		expect(result.stopReason).toBe(StopReason.MAX_TURNS);
	});

	it("should report progress summary via onProgress", async () => {
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "read_file", path: "test.ts" }),
			"完成。",
		]);
		const summaries: string[] = [];

		const result = await runTaorLoop("进度任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			onProgress: (info) => summaries.push(info.summary),
		});

		expect(summaries.length).toBeGreaterThan(0);
		expect(summaries[0]).toContain("已读");
		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
	});

	it("should handle abort signal", async () => {
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "list_dir", path: "." }),
		]);

		const controller = new AbortController();
		// Abort before the loop starts
		controller.abort();

		const result = await runTaorLoop("应取消的任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			abortSignal: controller.signal,
		});

		expect(result.stopReason).toBe(StopReason.ABORT);
	});

	it("should stop on empty model response", async () => {
		const model = new ControllableMockAdapter([""]);
		model.simulateEmptyResponse = true;

		const result = await runTaorLoop("测试空响应", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.ERROR);
	});

	it("should handle tool errors gracefully", async () => {
		const model = new ControllableMockAdapter([
			// Call a tool with invalid path
			JSON.stringify({ type: "read_file", path: "/non-existent-file.xyz" }),
			// Recover and respond directly
			"文件不存在，但已处理该错误。",
		]);

		const result = await runTaorLoop("读取不存在的文件", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		// Tool error should have been handled gracefully
		expect(result.toolCallCount).toBe(1);
		expect(result.finalAnswer).toBeTruthy();
	});

	it("should handle git tool calls through the loop", async () => {
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "git_status" }),
			"仓库状态已查看，当前在 master 分支。",
		]);

		const result = await runTaorLoop("查看 git 状态", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1);
		expect(result.finalAnswer).toBeTruthy();
	});

	it("should not crash when shell params are top-level (not nested under params)", async () => {
		// 回归测试：验证命令跟踪曾用 tc.params.command 读取，而工具调用参数是顶层格式
		// （{"type":"shell","command":"..."}），tc.params 为 undefined → 之前直接抛错
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "shell", command: "echo hi" }),
			"命令已执行。",
		]);

		const result = await runTaorLoop("执行命令", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1);
		expect(result.errorCount).toBe(0);
		expect(result.finalAnswer).toContain("命令已执行");
	});

	it("should provide callbacks via onTurn and onToolCall", async () => {
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "list_dir", path: "." }),
			"任务完成。",
		]);

		const turns: number[] = [];
		const toolCalls: any[] = [];

		const result = await runTaorLoop("测试回调", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			onTurn: (turn) => turns.push(turn),
			onToolCall: (tc) => toolCalls.push(tc),
		});

		expect(turns.length).toBeGreaterThanOrEqual(1);
		expect(toolCalls.length).toBe(1);
		expect(toolCalls[0].type).toBe("list_dir");
		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.duration).toBeGreaterThan(0);
		expect(result.errorCount).toBe(0);
	});

	it("should execute multiple tool calls in a single turn", async () => {
		const model = new ControllableMockAdapter([
			// Model outputs two tool calls in one response (DeepSeek style)
			'我先查看目录和搜索文件\n<tool_call>\n{"type":"list_dir","path":"."}\n</tool_call>\n<tool_call>\n{"type":"glob","pattern":"**/*.ts","path":"."}\n</tool_call>',
			"已查看目录结构，找到了所有 TypeScript 文件。",
		]);

		const result = await runTaorLoop("查看目录和文件", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(2);
		expect(result.turnCount).toBeGreaterThanOrEqual(1);
	});

	it("should handle partial tool failure in multi-call turn", async () => {
		const model = new ControllableMockAdapter([
			// First call succeeds, second fails
			'<tool_call>\n{"type":"list_dir","path":"."}\n</tool_call>\n<tool_call>\n{"type":"read_file","path":"/nonexistent.xyz"}\n</tool_call>',
			"处理了部分失败。",
		]);

		const result = await runTaorLoop("混合工具测试", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		// Should have executed both tools even though one failed
		expect(result.toolCallCount).toBe(2);
		expect(result.finalAnswer).toBeTruthy();
	});

	it("should report result metadata correctly", async () => {
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "list_dir", path: "." }),
			"已完成。",
		]);

		const result = await runTaorLoop("测试元数据", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 10 },
		});

		expect(result.turnCount).toBeGreaterThan(0);
		expect(result.toolCallCount).toBeGreaterThan(0);
		expect(result.duration).toBeGreaterThan(0);
		expect(typeof result.contextUsage).toBe("number");
		expect(result.finalAnswer).toBeTruthy();
	});

	it("should run compression pipeline without errors", async () => {
		// Force compression at 1% threshold — fires almost immediately
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "list_dir", path: "." }),
			"压缩测试完成。",
		]);

		const errors: Array<{ msg: string; site: string }> = [];
		const result = await runTaorLoop("测试压缩管道", {
			model,
			workDir: TEST_DIR,
			config: {
				maxTurns: 5,
				compactLevel: 1,
				compactThreshold: 0.01, // Very low threshold → compression on every turn
			},
			onError: (msg, site) => errors.push({ msg, site }),
		});

		// compression pipeline should not cause errors
		const compactFailures = errors.filter((e) => e.site === "compact_failure");
		expect(compactFailures.length).toBe(0);
		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
	});

	it("should handle memory manager gracefully", async () => {
		// MemoryManager should not crash even in temp directory without memory files
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "list_dir", path: "." }),
			"记忆测试完成。",
		]);

		const result = await runTaorLoop("测试记忆系统", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 3 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.errorCount).toBe(0);
	});

	it("should prevent context overflow with compression enabled", async () => {
		// Model keeps producing tool calls, consuming budget each turn.
		// With compression on, it should avoid CONTEXT_OVERFLOW.
		// V5: use 6 distinct calls cycling so loop detection doesn't fire (each sig ≤2 in window 6).
		const distinctCalls = [
			JSON.stringify({ type: "list_dir", path: "." }),
			JSON.stringify({ type: "list_dir", path: "src" }),
			JSON.stringify({ type: "list_dir", path: "test" }),
			JSON.stringify({ type: "glob", pattern: "**/*.ts" }),
			JSON.stringify({ type: "glob", pattern: "**/*.tsx" }),
			JSON.stringify({ type: "grep", pattern: "TODO" }),
		];
		const model = new ControllableMockAdapter(
			Array(50)
				.fill(0)
				.map((_, i) => distinctCalls[i % distinctCalls.length]),
		);

		const result = await runTaorLoop("长对话压缩测试", {
			model,
			workDir: TEST_DIR,
			config: {
				maxTurns: 10,
				compactLevel: 1,
				compactThreshold: 0.3, // Compress at 30% usage
			},
		});

		expect(result.stopReason).toBe(StopReason.MAX_TURNS); // Should hit max turns, not overflow
		expect(result.turnCount).toBe(10);
		expect(result.contextUsage).toBeLessThan(100); // Should not be at 100%
	});

	// ── V5 死循环检测 ──

	it("V5: should abort with LOOP_DETECTED on 3 identical tool calls", async () => {
		const model = new ControllableMockAdapter(
			Array(10).fill(JSON.stringify({ type: "list_dir", path: "." })),
		);

		const result = await runTaorLoop("死循环任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 10 },
		});

		expect(result.stopReason).toBe(StopReason.LOOP_DETECTED);
		expect(result.turnCount).toBe(3); // 第 3 次命中即终止
		expect(result.toolCallCount).toBe(2); // 第 3 次未执行（检测在 dispatch 前）
		expect(result.finalAnswer).toContain("死循环");
	});

	it("V5: should NOT trigger on varied tool calls (no false positive)", async () => {
		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "list_dir", path: "." }),
			JSON.stringify({ type: "read_file", path: "test.ts" }),
			JSON.stringify({ type: "glob", pattern: "**/*.ts" }),
			"完成。",
		]);

		const result = await runTaorLoop("多样工具任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(3);
	});

	// ── V8 智能截断 ──

	it("V8: should truncate long tool results with head/tail + ellipsis (not mid-line slice)", async () => {
		// 写一个 200 行、每行 ~50 字符的文件（总 ~10KB > 6000 截断阈值），read_file 一次读完
		const longFile = path.join(TEST_DIR, "long.txt");
		const lines = Array.from(
			{ length: 200 },
			(_, i) => `line-${String(i).padStart(3, "0")}-${"x".repeat(40)}`,
		);
		fs.writeFileSync(longFile, lines.join("\n"), "utf-8");

		const model = new ControllableMockAdapter([
			JSON.stringify({ type: "read_file", path: "long.txt" }),
			"完成。",
		]);

		let injectedResult = "";
		const result = await runTaorLoop("读取大文件", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 3 },
			onTurn: (_t, state) => {
				const msgs = (state as any)?.messages || [];
				const toolResultMsg = [...msgs]
					.reverse()
					.find(
						(m: any) =>
							m.role === "user" &&
							typeof m.content === "string" &&
							m.content.startsWith("工具结果:"),
					);
				if (toolResultMsg && !injectedResult)
					injectedResult = toolResultMsg.content;
			},
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(injectedResult).toBeTruthy();
		// 头部保留（含 line-000）
		expect(injectedResult).toContain("line-000");
		// 尾部保留（含 line-199）
		expect(injectedResult).toContain("line-199");
		// 中间被省略（line-100 不应出现）
		expect(injectedResult).not.toContain("line-100");
		// 含省略提示
		expect(injectedResult).toContain("省略");
	});

	// ── A2 验证 gate 事件 ──

	it("A2: should fire onVerifyGate with gate_blocked when auto-verify is not satisfied", async () => {
		const dir = path.join(TEST_DIR, "verifytest");
		fs.mkdirSync(dir, { recursive: true });

		const model = new ControllableMockAdapter([
			// Turn 1: 写文件 → checkpoint.modifiedCount > 0（未运行验证命令，verify.ran=false）
			JSON.stringify({
				type: "write_file",
				path: "app.ts",
				content: "export const x = 1;\n",
			}),
			// Turn 2+: 模型直接收尾 → 触发 gate 拦截（代码已修改但尚未验证）
			"任务完成。",
		]);

		const verifyEvents: Array<{
			type: string;
			rounds: number;
			command?: string;
		}> = [];
		const result = await runTaorLoop("修改代码并验证", {
			model,
			workDir: dir,
			config: {
				maxTurns: 8,
				verifyMode: "auto",
				verifyCommand: "npm test",
				maxVerifyRounds: 1,
			},
			onVerifyGate: (info) => verifyEvents.push(info),
		});

		// 至少拦截过一次，且首条为 gate_blocked
		expect(verifyEvents.length).toBeGreaterThan(0);
		expect(verifyEvents[0].type).toBe("gate_blocked");
		expect(verifyEvents[0].command).toBe("npm test");
		expect(verifyEvents[0].rounds).toBeGreaterThanOrEqual(1);
		// 拦截达到轮次上限后显式失败（不再静默放行伪装成功）
		expect(verifyEvents[verifyEvents.length - 1].type).toBe("verify_failed");
		expect(result.stopReason).toBe(StopReason.VERIFY_FAILED);
		expect(result.finalAnswer).toContain("任务未达标");
	});

	// ── B3 断点续跑 ──

	it("B3: resume 播种 transcript 且不复放已执行工具", async () => {
		const preloaded: Message[] = [
			{ role: "user", content: "请修改 test.ts 添加注释" },
			{
				role: "assistant",
				content: JSON.stringify({
					type: "write_file",
					path: "test.ts",
					content: "// 注释\nconst x = 1;\n",
				}),
			},
			{
				role: "user",
				content: '工具结果: {"success":true,"summary":"写入成功: test.ts"}',
			},
		];
		const resumeModel = new ControllableMockAdapter([
			// 续跑后模型直接应答（不再调用工具 → 验证工具历史不复放）
			"已完成修改。",
		]);
		let seenMessages: Message[] | null = null;

		const result = await runTaorLoop("请修改 test.ts 添加注释", {
			model: resumeModel,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			resume: {
				messages: preloaded,
				turnCount: 1,
				checkpoint: {
					updatedAt: Date.now(),
					filesRead: [],
					filesWritten: ["test.ts"],
					verify: { ran: false, passed: false, rounds: 0 },
					turnsUsed: 1,
					plan: null,
					milestones: ["任务中断"],
				},
			},
			resumeId: "test-resume-1",
			onTurn: (_turn, state) => {
				seenMessages = (state as any)?.messages;
			},
		});

		// 不重放已执行工具
		expect(result.toolCallCount).toBe(0);
		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		// 轮次从 1 续起 + 新 1 轮
		expect(result.turnCount).toBe(2);
		expect(seenMessages).toBeTruthy();
		const userMsgs = (seenMessages as Message[]).filter(
			(m) => m.role === "user" && !m.content.startsWith("工具结果:"),
		);
		// 原始用户输入只播种一次，未被 resume 二次追加
		expect(userMsgs).toHaveLength(1);
		expect(userMsgs[0].content).toContain("请修改 test.ts");
		// 播种子消息完整保留（含已执行工具历史）
		expect(
			(seenMessages as Message[]).some((m) => m.content.includes("write_file")),
		).toBe(true);
	});

	it("B3: resume 后 checkpoint 状态累积（seed 快照）", async () => {
		const resumeModel = new ControllableMockAdapter(["续跑完成。"]);
		const result = await runTaorLoop("续跑任务", {
			model: resumeModel,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			resume: {
				messages: [
					{ role: "user", content: "续跑任务" },
					{
						role: "assistant",
						content: JSON.stringify({
							type: "write_file",
							path: "x.ts",
							content: "1",
						}),
					},
					{ role: "user", content: '工具结果: {"success":true}' },
				],
				turnCount: 1,
				checkpoint: {
					updatedAt: Date.now(),
					filesRead: ["a.ts"],
					filesWritten: ["x.ts"],
					verify: {
						ran: true,
						passed: true,
						rounds: 0,
						lastCommand: "npm test",
					},
					turnsUsed: 1,
					plan: null,
					milestones: [],
				},
			},
			resumeId: "test-resume-2",
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(0);
		expect(result.errorCount).toBe(0);
	});

	// ── C2 目标闭环（goalMode）──

	it("C2: goal_mode 达标（验证命令通过）→ goal_passed 自动结束", async () => {
		const dir = path.join(TEST_DIR, "goaltest-met");
		fs.mkdirSync(dir, { recursive: true });

		const model = new ControllableMockAdapter([
			JSON.stringify({
				type: "write_file",
				path: "app.ts",
				content: "export const x = 2;\n",
			}),
			JSON.stringify({ type: "shell", params: { command: "npm test" } }),
			"任务完成，测试通过。",
		]);

		const events: string[] = [];
		const result = await runTaorLoop("重构并确保测试通过", {
			model,
			workDir: dir,
			config: {
				maxTurns: 8,
				verifyMode: "auto",
				goalMode: true,
				goalCriterion: "运行 npm test 且全部通过",
				goalMaxRounds: 2,
			},
			extraHandlerOverrides: {
				shell: async () => ({
					success: true,
					data: "Tests: 10 passed, 0 failed",
					error: "",
				}),
			},
			onVerifyGate: (info) => events.push(info.type),
		});

		expect(events).toContain("goal_passed");
		expect(events).not.toContain("goal_blocked");
		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.finalAnswer).toContain("任务完成");
	});

	it("C2: goal_mode 未达标 → goal_blocked 注入验收标准，达上限显式失败", async () => {
		const dir = path.join(TEST_DIR, "goaltest-limit");
		fs.mkdirSync(dir, { recursive: true });

		const model = new ControllableMockAdapter([
			JSON.stringify({
				type: "write_file",
				path: "app.ts",
				content: "export const x = 3;\n",
			}),
			"任务完成。",
			"任务完成。",
			"任务完成。",
		]);

		const events: Array<{ type: string; message: string }> = [];
		const result = await runTaorLoop("重构代码", {
			model,
			workDir: dir,
			config: {
				maxTurns: 10,
				verifyMode: "auto",
				goalMode: true,
				goalCriterion: "运行 pnpm test 且全部通过",
				goalMaxRounds: 2,
			},
			onVerifyGate: (info) =>
				events.push({ type: info.type, message: info.message }),
		});

		const blocked = events.filter((e) => e.type === "goal_blocked");
		expect(blocked.length).toBe(2);
		expect(blocked[0].message).toContain("pnpm test");
		// 达上限后显式失败（不再伪装 goal_passed）
		expect(events[events.length - 1].type).toBe("goal_failed");
		expect(result.stopReason).toBe(StopReason.VERIFY_FAILED);
		expect(result.finalAnswer).toContain("未能确认满足");
	});

	// ── C3-M1 原生 Tool Calling 共享核心 ──

	it("C3-M1: 原生 tool_calls(带 id)走结构化回灌 role:tool 而非文本 user 结果", async () => {
		const model = new ControllableMockAdapter([
			// Turn 1: 原生 tool_call（streamParser 注入的 JSON 行带 id）
			JSON.stringify({ type: "list_dir", id: "call_abc123", path: "." }),
			// Turn 2: 模型直接应答完成
			"已完成。",
		]);

		let lastMessages: any[] = [];
		const result = await runTaorLoop("原生工具调用任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			onTurn: (_t, state) => {
				lastMessages = (state as any)?.messages || [];
			},
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1);

		// 原生路径：assistant 消息携带结构化 toolCalls（id + name + arguments）
		const assistantWithToolCalls = lastMessages.filter(
			(m) =>
				m.role === "assistant" &&
				Array.isArray(m.toolCalls) &&
				m.toolCalls.length > 0,
		);
		expect(assistantWithToolCalls.length).toBeGreaterThan(0);
		const meta = assistantWithToolCalls[0].toolCalls[0];
		expect(meta.id).toBe("call_abc123");
		expect(meta.name).toBe("list_dir");
		expect(JSON.parse(meta.arguments)).toEqual({ path: "." });

		// 原生路径：结果以 role:"tool" 消息回灌，tool_call_id 对齐
		const toolMsgs = lastMessages.filter((m) => m.role === "tool");
		expect(toolMsgs.length).toBeGreaterThan(0);
		expect(toolMsgs[0].tool_call_id).toBe("call_abc123");
		expect(toolMsgs[0].content).toContain('"success"');
		// 不再生成文本 user 结果
		expect(
			lastMessages.filter(
				(m) => m.role === "user" && m.content.startsWith("工具结果:"),
			),
		).toHaveLength(0);
	});

	it("C3-M1: 文本 <tool_call>(无 id)仍走 user 结果回灌(向后兼容)", async () => {
		const model = new ControllableMockAdapter([
			'<tool_call>\n{"type":"list_dir","path":"."}\n</tool_call>',
			"已完成。",
		]);

		let lastMessages: any[] = [];
		const result = await runTaorLoop("文本工具调用任务", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			onTurn: (_t, state) => {
				lastMessages = (state as any)?.messages || [];
			},
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1);
		// 文本路径：无 role:"tool" 消息
		expect(lastMessages.filter((m) => m.role === "tool")).toHaveLength(0);
		// 结果仍以 user 文本回灌
		expect(
			lastMessages.filter(
				(m) => m.role === "user" && m.content.startsWith("工具结果:"),
			),
		).toHaveLength(1);
	});

	// ── C3-M2 原生提示词修复：原生 provider 不再强制 <tool_call> 文本格式 ──

	it("C3-M2: 原生 provider(deepseek) 使用原生函数调用提示词，不含 <tool_call> 文本格式", async () => {
		const model = new ControllableMockAdapter(["完成。"], {
			provider: "deepseek",
		});
		await runTaorLoop("测试原生提示词", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 3 },
		});

		expect(model.lastSystemPrompt).toContain("原生函数调用");
		expect(model.lastSystemPrompt).not.toContain("## 工具调用格式（必须遵守）");
		expect(model.lastSystemPrompt).not.toContain("## 可用工具");
	});

	it("C3-M2: 非原生 provider(test-mock) 保留文本 <tool_call> 格式提示词 + 工具清单", async () => {
		const model = new ControllableMockAdapter(["完成。"], {
			provider: "test-mock",
		});
		await runTaorLoop("测试文本提示词", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 3 },
		});

		expect(model.lastSystemPrompt).toContain("<tool_call>");
		expect(model.lastSystemPrompt).toContain("## 可用工具");
	});

	it("C3-M2: 同 id 重复原生工具调用去重，只执行一次", async () => {
		const dup = JSON.stringify({ type: "list_dir", id: "call_dup", path: "." });
		const model = new ControllableMockAdapter([`${dup}\n${dup}`, "完成。"]);
		const toolCalls: any[] = [];
		const result = await runTaorLoop("去重测试", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			onToolCall: (tc) => toolCalls.push(tc),
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].id).toBe("call_dup");
	});

	it("C3-M2: 原生工具 JSON 不泄漏到存储消息与流式展示", async () => {
		const native = JSON.stringify({
			path: ".",
			type: "list_dir",
			id: "call_abc",
		});
		const model = new ControllableMockAdapter([
			`我先查看目录。${native}`,
			"完成。",
		]);
		const fullTexts: string[] = [];
		let lastMessages: any[] = [];
		const result = await runTaorLoop("原生泄漏测试", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			onToken: (_t, fullText) => fullTexts.push(fullText),
			onTurn: (_t, state) => {
				lastMessages = (state as any)?.messages || [];
			},
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1);
		// 存储的 assistant 内容：正文保留、原生 JSON 剔除
		const assistantMsg = lastMessages.find(
			(m) =>
				m.role === "assistant" &&
				Array.isArray(m.toolCalls) &&
				m.toolCalls.length > 0,
		);
		expect(assistantMsg).toBeTruthy();
		expect(assistantMsg.content).toContain("我先查看目录");
		expect(assistantMsg.content).not.toContain('"id":"call_abc"');
		// 流式展示 fullText：同样剔除 JSON
		expect(fullTexts[0]).toContain("我先查看目录");
		expect(fullTexts[0]).not.toContain('"id":"call_abc"');
	});

	it("C3-M2 回归: 文本路径正文的残缺 <tool_call 标记不泄漏到存储消息", async () => {
		// 复现用户实测形态：DeepSeek V4 Flash 在正文输出不带 > 的残缺 <tool_call 片段。
		// 流式展示层由 daemon（index.ts:1071 / combatUnit.ts:274）用 stripToolCalls 剥离，
		// 但存储的 assistant 消息此前只剥 think → 标记原样入库，会话历史/重载后正文再次显示。
		// 本测试钉死存储路径（taorLoop.ts:581）。onToken 原始流不在本层断言（daemon 层才剥）。
		const model = new ControllableMockAdapter([
			'我先了解项目。<tool_call\n{"type":"list_dir","path":"."}\n<tool_call文件内容。',
			"完成。",
		]);
		let lastMessages: any[] = [];
		const result = await runTaorLoop("正文泄漏测试", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			onTurn: (_t, state) => {
				lastMessages = (state as any)?.messages || [];
			},
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1); // 裸 JSON 仍被解析执行，只是展示剥离
		// 存储的 assistant 正文：叙事保留、<tool_call 标记剔除
		const assistantMsg = lastMessages.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeTruthy();
		expect(assistantMsg.content).toContain("我先了解项目");
		expect(assistantMsg.content).not.toContain("<tool_call");
	});

	// ── C3-M3 富结构通道：结构化 tool_calls 事件（阵营 B）──

	it("C3-M3: 富结构 tool_calls 事件 → 执行 + role:'tool' 回灌 + 无泄漏", async () => {
		const model = new ControllableMockAdapter(["让我查看目录。", "完成。"], {
			provider: "anthropic",
		});
		model.structuredToolCalls = [
			[{ id: "toolu_1", name: "list_dir", arguments: '{"path":"."}' }],
			null,
		];
		const fullTexts: string[] = [];
		let lastMessages: any[] = [];
		const result = await runTaorLoop("富结构测试", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
			onToken: (_t, fullText) => fullTexts.push(fullText),
			onTurn: (_t, state) => {
				lastMessages = (state as any)?.messages || [];
			},
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1);
		// 原生路径：assistant 携带结构化 toolCalls
		const assistantMsg = lastMessages.find(
			(m) =>
				m.role === "assistant" &&
				Array.isArray(m.toolCalls) &&
				m.toolCalls.length > 0,
		);
		expect(assistantMsg).toBeTruthy();
		expect(assistantMsg.toolCalls[0].id).toBe("toolu_1");
		expect(assistantMsg.toolCalls[0].name).toBe("list_dir");
		// 富结构：工具 JSON 从未进 content 文本 → 存储与流式展示均无泄漏
		expect(assistantMsg.content).toContain("让我查看目录");
		expect(assistantMsg.content).not.toContain("toolu_1");
		expect(fullTexts[0]).toContain("让我查看目录");
		expect(fullTexts[0]).not.toContain("toolu_1");
		// 结果独立 role:"tool" 回灌，tool_call_id 对齐原生 id
		const toolMsg = lastMessages.find((m) => m.role === "tool");
		expect(toolMsg).toBeTruthy();
		expect(toolMsg.tool_call_id).toBe("toolu_1");
	});

	it("C3-M3: 纯工具调用（无文本）不算空响应，正常执行", async () => {
		const model = new ControllableMockAdapter(["", "完成。"], {
			provider: "anthropic",
		});
		model.structuredToolCalls = [
			[{ id: "toolu_2", name: "list_dir", arguments: '{"path":"."}' }],
			null,
		];
		const result = await runTaorLoop("纯工具调用", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1);
		expect(result.errorCount).toBe(0);
	});

	it("C3-M4: google provider 走原生提示词 + 富结构工具调用（合成 id）", async () => {
		const model = new ControllableMockAdapter(["", "完成。"], {
			provider: "google",
		});
		model.structuredToolCalls = [
			[{ id: "list_dir::0", name: "list_dir", arguments: '{"path":"."}' }],
			null,
		];
		const result = await runTaorLoop("gemini 原生工具", {
			model,
			workDir: TEST_DIR,
			config: { maxTurns: 5 },
		});

		expect(result.stopReason).toBe(StopReason.NO_TOOL_USE);
		expect(result.toolCallCount).toBe(1);
		expect(result.errorCount).toBe(0);
		// 原生提示词（无文本格式指令 → 防 M2 式双重输出）
		expect(model.lastSystemPrompt).toContain("原生函数调用");
		expect(model.lastSystemPrompt).not.toContain(
			"JSON 包裹在 <tool_call> 标签内",
		);
	});
});
