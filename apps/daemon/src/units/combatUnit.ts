import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { SessionCollector } from "@xuancode/database";
import {
	type ProjectCheckpointSnapshot,
	runTaorLoop,
	stripThinkContent,
	stripToolCalls,
} from "@xuancode/orchestrator";
import { Tracer } from "@xuancode/telemetry";
import type { AgentTrace } from "@xuancode/telemetry";
import { SEMANTIC_SEARCH_DEF, ToolManager } from "@xuancode/tools";
import type { AgentConfig, AttachmentBlock, StopReason } from "@xuancode/types";
import type { Message } from "@xuancode/types";
import { ComputerUseService } from "../computerUse/computerUseService.js";
import { createComputerUseExtraDefinitions } from "../computerUse/computerUseTool.js";
import { createModel, setModels } from "../models/modelRegistry";
import type { ModelEntry } from "../models/modelRegistry";
import { UnitBase } from "./UnitBase.js";

// ===== Payload Types =====

interface ExecuteTaskPayload {
	augmentedInput: string;
	attachments?: AttachmentBlock[];
	workDir: string;
	config: Partial<AgentConfig>;
	provider: string;
	modelName: string;
	computerUseEnabled: boolean;
	maxTaskDuration: number;
	historyMessages?: Message[];
	sessionId?: string;
	modelEntries?: ModelEntry[];
	reasoningLevel?: "fast" | "medium" | "expert";
	resume?: {
		messages: Message[];
		turnCount: number;
		checkpoint: ProjectCheckpointSnapshot;
	};
	resumeId?: string;
}

interface ExecuteTaskResponse {
	success: boolean;
	result?: {
		finalAnswer: string;
		turnCount: number;
		stopReason: StopReason;
		duration: number;
		toolCallCount: number;
		errorCount?: number;
		contextUsage?: number;
	};
	error?: string;
	collectedEntries: any[];
	lastMessages: Message[] | null;
	traceId?: string;
	traceData?: AgentTrace | null;
}

// ===== COMBAT Worker Unit =====

class CombatUnit extends UnitBase {
	protected readonly unitName = "COMBAT";
	private currentAbortController: AbortController | null = null;
	/** ask_user 等待中的 resolver（correlationId → resolve） */
	private pendingAskUser = new Map<string, (answer: string) => void>();

	constructor() {
		super();

		// ---- Abort current task ----
		this.onCommand("abort_task", async () => {
			console.error("[COMBAT] abort_task received — aborting current task");
			this.currentAbortController?.abort();
		});

		// ---- Answer ask_user question (sent by main thread on /tasks/:id/input) ----
		this.onCommand("answer_user", async (payload: any) => {
			const correlationId = payload?.correlationId;
			const resolver = correlationId
				? this.pendingAskUser.get(correlationId)
				: undefined;
			if (resolver) {
				this.pendingAskUser.delete(correlationId);
				resolver(String(payload?.answer ?? ""));
			} else {
				console.error(
					"[COMBAT] answer_user: no pending resolver for correlationId",
					correlationId,
				);
			}
		});

		// ---- Execute task ----
		this.onRequest("execute_task", async (payload: unknown) => {
			const p = payload as ExecuteTaskPayload;
			const abortController = new AbortController();
			this.currentAbortController = abortController;

			// 空闲超时：连续 p.maxTaskDuration 内无 token/工具/轮次活动才中止（非墙钟硬杀）
			const idle = new IdleAbort(p.maxTaskDuration);
			const combinedSignal =
				(AbortSignal.any as any)?.([idle.signal, abortController.signal]) ||
				idle.signal;

			let tracer: Tracer | null = null;
			const collector = new SessionCollector();
			let lastMessages: Message[] | null = null;
			let lastCleanText = "";
			let reasoningBuf = "";
			let capturedTraceId: string | null = null;

			try {
				// 1. Load registry (with overrides from main thread) and create ModelRouter
				if (p.modelEntries) setModels(p.modelEntries);
				const model = createModel(p.provider, p.modelName);

				// 2. Create ToolManager
				const toolManager = new ToolManager(p.workDir, p.config?.mode);

				// 3. Optional telemetry tracer
				if (process.env.ENABLE_TELEMETRY === "true") {
					tracer = new Tracer({
						maxSpans: 500,
						maxTraces: 50,
						sinkDir: path.join(
							process.env.XUANCODE_HOME || process.env.HOME || os.homedir(),
							".xuancode",
							"telemetry",
						),
					});
					// Bridge tracer span events to IPC (for real-time telemetry in UI)
					tracer.onSpanEvent("span_start", (span) => {
						this.sendEvent("telemetry_span", { type: "span_start", ...span });
					});
					tracer.onSpanEvent("span_end", (span) => {
						this.sendEvent("telemetry_span", { type: "span_end", ...span });
					});
				}

				// 4. Extra definitions (semantic search, computer use, ask_user)
				const extraDefs: Array<{
					def: any;
					handler: (params: any) => Promise<any>;
				}> = [
					{
						def: SEMANTIC_SEARCH_DEF,
						handler: async (params) => {
							const { semanticSearch } = await import("@xuancode/tools");
							return semanticSearch(params.query || "", params.path);
						},
					},
					{
						def: {
							type: "ask_user",
							name: "ask_user",
							description:
								"向用户提出一个问题并等待选择。仅在真正需要用户决策或方向选择时使用（避免频繁打断）。question 用一句话说清当前处境与要决策的点；options 提供 2~4 个互斥、可直接执行的分支方案，用户选择后按所选分支继续。",
							parameters: [
								{
									name: "question",
									type: "string",
									description: "要决策的问题（一句话说清处境 + 决策点）",
									required: true,
								},
								{
									name: "options",
									type: "array",
									description: "可选分支方案列表（2~4 个，互斥且可直接执行）",
									required: false,
								},
							],
							examples: [
								{
									description: "询问方向选择",
									params: {
										question: "FileTree 改进下一步优先推进哪个方向？",
										options: [
											"先实现 FileTree 轻量拓扑结构",
											"先实现高维阶图谱渲染",
											"先补齐单元测试",
										],
									},
								},
							],
							alwaysLoad: true,
							category: "earth",
						},
						handler: async (params: any) => {
							const question = String(params.question || "");
							const options = Array.isArray(params.options)
								? params.options.map(String)
								: [];
							const correlationId = randomUUID();
							// 等用户回答期间挂起空闲计时（用户想多久都行）
							idle.suspend();
							return new Promise((resolve) => {
								const done = (data: { success: true; data: string }) => {
									idle.resume();
									resolve(data);
								};
								const timeout = setTimeout(() => {
									if (this.pendingAskUser.has(correlationId)) {
										this.pendingAskUser.delete(correlationId);
										done({
											success: true,
											data: "(用户未在 5 分钟内回答，请按最合理分支继续)",
										});
									}
								}, 300_000);
								this.pendingAskUser.set(correlationId, (answer: string) => {
									clearTimeout(timeout);
									done({ success: true, data: `用户选择: ${answer}` });
								});
								this.sendEvent("ask_user", {
									correlationId,
									question,
									options,
								});
							});
						},
					},
				];
				if (p.computerUseEnabled) {
					const cu = new ComputerUseService();
					extraDefs.push(...createComputerUseExtraDefinitions(cu));
				}

				// 5. Build full input with history summary
				let historySummary = "";
				if (p.historyMessages?.length) {
					const parts: string[] = [];
					for (const msg of p.historyMessages) {
						if (msg.role === "user" && !msg.content.startsWith("工具结果:")) {
							parts.push(`用户: ${msg.content.slice(0, 500)}`);
						} else if (msg.role === "assistant") {
							parts.push(`玄码: ${msg.content.slice(0, 1000)}`);
						}
					}
					historySummary = parts.join("\n").slice(0, 4000);
				}
				const augmentedInput = historySummary
					? `[上轮对话]\n${historySummary}\n\n[当前问题]\n${p.augmentedInput}`
					: p.augmentedInput;

				// 6. Run TAOR loop — all callbacks bridged via sendEvent
				const result = await runTaorLoop(augmentedInput, {
					attachments: p.attachments,
					model,
					workDir: p.workDir,
					config: p.config,
					resume: p.resume,
					resumeId: p.resumeId,
					abortSignal: combinedSignal,
					tracer: tracer ?? undefined,
					extraDefinitions: extraDefs,
					reasoningLevel: p.reasoningLevel,
					onTurn: (turn, state) => {
						idle.activity();
						const s = state as any;
						const totalChars =
							s.messages?.reduce?.(
								(sum: number, m: any) => sum + (m.content?.length || 0),
								0,
							) ?? 0;
						const maxBudget = s.maxContextBudget ?? 1;
						const contextUsage = Math.min(
							100,
							Math.round((totalChars / maxBudget) * 100),
						);
						this.sendEvent("turn", { turn, contextUsage });
						collector.captureNewMessages(turn, s);
						// Keep a reference to messages for multi-turn memory
						if (s?.messages?.length) {
							lastMessages = s.messages;
						}
						// Capture trace ID on first turn (before endTrace clears activeTrace)
						if (!capturedTraceId) {
							capturedTraceId = tracer?.getActiveTrace()?.id || null;
						}
					},
					onProgress: (info: {
						turn: number;
						summary: string;
						toolCallCount: number;
					}) => {
						idle.activity();
						this.sendEvent("progress", info);
					},
					onToolCall: (tc: any, tr: any) => {
						idle.activity();
						this.sendEvent("tool_call", {
							toolType: tc.type,
							params: {
								path: tc.path,
								command: tc.command,
								pattern: tc.pattern,
								content: tc.content?.slice(0, 5000),
							},
							result: {
								success: tr.success,
								error: tr.error,
								output: tr.data?.slice(0, 10000),
								duration: tr.duration,
							},
						});
						collector.captureToolCall(0, tc, tr);
					},
					onError: (message: string, site: string) => {
						idle.activity();
						this.sendEvent("error", { message, site });
						collector.captureError(0, message, site);
					},
					onToken: (_token: string, fullText: string) => {
						idle.activity();
						const openThink = fullText.lastIndexOf("<think>");
						const closeThink = fullText.lastIndexOf("</think>");
						const openTool = fullText.lastIndexOf("<tool_call>");
						const closeTool = fullText.lastIndexOf("</tool_call>");
						const inThink = openThink > closeThink;
						const inTool = openTool > closeTool;

						// Inside think block → extract and emit reasoning tokens
						if (inThink) {
							const afterTag = fullText
								.slice(openThink + 7)
								.replace(/<\/think>[\s\S]*$/, "");
							if (afterTag.length > reasoningBuf.length) {
								const delta = afterTag.slice(reasoningBuf.length);
								reasoningBuf = afterTag;
								this.sendEvent("reasoning", { token: delta });
							}
							return;
						}

						// Inside tool_call block → skip (no token event)
						if (inTool) return;

						// Think block just closed — flush remaining reasoning content
						if (reasoningBuf) {
							if (closeThink > openThink) {
								const finalReasoning = fullText.slice(
									openThink + 7,
									closeThink,
								);
								if (finalReasoning.length > reasoningBuf.length) {
									const delta = finalReasoning.slice(reasoningBuf.length);
									reasoningBuf = finalReasoning;
									this.sendEvent("reasoning", { token: delta });
								}
							}
							reasoningBuf = "";
						}

						// Strip trailing partial tag (e.g. "<tool" before "<tool_call>" completes)
						// before computing clean text, so partial tags never leak into delta
						const safeFull = fullText.replace(/<[\w\/]*$/, "");
						const cleanText = stripToolCalls(stripThinkContent(safeFull));
						// Prefix invariant guard: 防止归一化导致 cleanText 比 lastCleanText 短
						if (cleanText.length >= lastCleanText.length) {
							const delta = cleanText.slice(lastCleanText.length);
							if (delta) {
								this.sendEvent("token", { token: delta });
							}
							lastCleanText = cleanText;
						} else {
							lastCleanText = cleanText;
						}
					},
				});

				// 7. Return success response with trace data for optimizer
				const fullTrace = capturedTraceId
					? tracer?.getTrace(capturedTraceId)
					: null;
				return {
					success: true,
					result: {
						finalAnswer: result.finalAnswer,
						turnCount: result.turnCount,
						stopReason: result.stopReason,
						duration: result.duration,
						toolCallCount: result.toolCallCount,
						errorCount: result.errorCount ?? undefined,
						contextUsage: result.contextUsage,
					},
					collectedEntries: collector.getEntries(),
					lastMessages,
					traceId: capturedTraceId ?? undefined,
					traceData: fullTrace,
				} satisfies ExecuteTaskResponse;
			} catch (err: any) {
				// Handle abort gracefully — don't treat AbortError as failure
				if (err.name === "AbortError" || err.message?.includes("abort")) {
					console.error("[COMBAT] Task aborted");
					return {
						success: false,
						error: "Task was cancelled",
						collectedEntries: [],
						lastMessages: null,
					} satisfies ExecuteTaskResponse;
				}
				console.error("[COMBAT] Task execution error:", err);
				return {
					success: false,
					error: err.message || String(err),
					collectedEntries: collector.getEntries(),
					lastMessages: null,
				} satisfies ExecuteTaskResponse;
			} finally {
				idle.dispose();
				this.currentAbortController = null;
			}
		});

		this.startHeartbeat();
		console.error("[COMBAT] Unit initialized");
	}
}

// ===== Self-instantiate =====

/**
 * 空闲超时（与 daemon 侧同语义）：墙钟硬杀会打断数小时的长任务，
 * 只有「连续 idleMs 内无任何 token/工具/轮次活动」才判定超时。
 * ask_user 等待用户回答期间挂起计时。
 */
class IdleAbort {
	private controller = new AbortController();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private waitCount = 0;

	constructor(private idleMs: number) {
		this.arm();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** 任一活动回调（onToken/onTurn/onToolCall/onProgress/onError）调用 */
	activity(): void {
		if (this.controller.signal.aborted) return;
		this.arm();
	}

	suspend(): void {
		this.waitCount++;
		this.disarm();
	}

	resume(): void {
		this.waitCount = Math.max(0, this.waitCount - 1);
		if (this.waitCount === 0 && !this.controller.signal.aborted) this.arm();
	}

	dispose(): void {
		this.disarm();
	}

	private arm(): void {
		this.disarm();
		this.timer = setTimeout(() => {
			this.timer = null;
			if (!this.controller.signal.aborted) {
				this.controller.abort(
					new Error(
						`空闲超时：连续 ${Math.round(this.idleMs / 60_000)} 分钟无输出/工具活动`,
					),
				);
			}
		}, this.idleMs);
		this.timer.unref?.();
	}

	private disarm(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}

new CombatUnit();
