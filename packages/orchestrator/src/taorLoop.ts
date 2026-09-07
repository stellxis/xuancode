import {
	CacheBoundaryManager,
	MemoryManager,
	compactMessages,
} from "@xuancode/context";
import type { ApiToolDefinition, ModelAdapter } from "@xuancode/model-adapter";
import { toApiTools } from "@xuancode/model-adapter";
import type { Tracer } from "@xuancode/telemetry";
import { ToolManager } from "@xuancode/tools";
import {
	type AgentConfig,
	type AgentState,
	type AttachmentBlock,
	CompactLevel,
	type NativeToolCall,
	StopReason,
	type ToolCallParams,
	type ToolDefinition as ToolDef,
	type ToolResult,
} from "@xuancode/types";
import type { Message } from "@xuancode/types";
import { ContinueSite, getRecovery } from "./errorRecovery";
import {
	ProjectCheckpoint,
	type ProjectCheckpointSnapshot,
	clearResumeState,
	writeResumeState,
} from "./projectCheckpoint";
import { StateManager } from "./stateManager";
import { checkStopConditions } from "./stopConditions";
import { StreamingToolExecutor } from "./streamExecutor";
import {
	hasToolCallArtifacts,
	parseAllToolCalls,
	parseToolCall,
	stripNativeToolJson,
	stripThinkContent,
	stripToolCalls,
} from "./toolParser";
import {
	evaluateVerifyGate,
	extractVerifyErrors,
	isVerifyCommand,
	truncateCompileOutput,
} from "./verify";
import { WorkflowPlanManager, createWorkflowToolDefinitions } from "./workflow";

/**
 * V8 智能截断：避免粗暴 slice 切在行/JSON 中间导致模型重读。
 * - data 长度 <= max 直接返回
 * - JSON 优先按对象边界 pretty-print 后 head/tail
 * - 否则按行 head + 「...（省略 N 行）...」+ tail
 * - 单行超长退化到字符 head/tail
 */
function smartTruncate(data: string | undefined, max: number): string {
	if (!data) return "";
	if (data.length <= max) return data;
	if (max < 80) return data.slice(0, max); // 预算极小时退化为 slice

	// 尝试 JSON
	try {
		const parsed = JSON.parse(data);
		const pretty = JSON.stringify(parsed, null, 2);
		if (pretty.length <= max) return pretty;
		const lines = pretty.split("\n");
		return truncateLines(lines, max, "行");
	} catch {
		// 非 JSON
	}

	// 按行处理
	const lines = data.split(/\r?\n/);
	if (lines.length === 1) {
		// 单行超长：字符 head/tail
		const head = Math.floor((max - 30) * 0.7);
		const tail = max - 30 - head;
		return `${data.slice(0, head)}\n...（省略 ${data.length - max + 30} 字符）...\n${data.slice(-tail)}`;
	}
	return truncateLines(lines, max, "行");
}

function truncateLines(lines: string[], max: number, unit: string): string {
	// 保留首 40% + 尾 30% 的预算，中间放省略提示
	const ellipsis = `\n...（省略 N ${unit}）...\n`;
	const budget = max - ellipsis.length - 20;
	const headBudget = Math.floor(budget * 0.6);
	const tailBudget = budget - headBudget;

	const headLines: string[] = [];
	let headLen = 0;
	for (const line of lines) {
		if (headLen + line.length + 1 > headBudget) break;
		headLines.push(line);
		headLen += line.length + 1;
	}
	const tailLines: string[] = [];
	let tailLen = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (tailLen + lines[i].length + 1 > tailBudget) break;
		if (headLines.includes(lines[i])) break; // 不重复
		tailLines.unshift(lines[i]);
		tailLen += lines[i].length + 1;
	}
	const omitted = lines.length - headLines.length - tailLines.length;
	const ellipsisFinal = ellipsis.replace("N", String(omitted));
	return headLines.join("\n") + ellipsisFinal + tailLines.join("\n");
}

export const XUANCODE_SYSTEM_PROMPT_CORE = `你是玄码 (XuanCode) — 国风科技智能编码中枢。

## 核心原则
- 你是专业软件开发助手,遵循用户意图完成编码任务
- 任务完成后给出总结
- 工具结果会以"工具结果: {...}"格式返回给你
- 执行任务过程中,若顺带发现明显的小缺陷(如未定义变量、明显空引用等),可顺手修复;但修复不得超出当前任务范围,不得引入与本任务无关的改动`;

/** 文本格式工具调用提示词（无原生 tool_calling 的 provider / Ollama 兜底） */
export const XUANCODE_TOOL_PROMPT_TEXT = `## 工具调用格式（必须遵守）
如需调用工具，必须使用以下格式（JSON 包裹在 <tool_call> 标签内）：

<tool_call>
{"type":"工具名称","参数名":"参数值"}
</tool_call>

示例（读取文件）：
<tool_call>
{"type":"read_file","path":"package.json"}
</tool_call>

示例（执行命令）：
<tool_call>
{"type":"shell","command":"npm test"}
</tool_call>

重要规则：
- 每次只调用一个工具，等待结果后再决定下一步
- 不要使用 <invoke> 或其他 XML 标签格式
- 工具名称必须是可用工具列表中的 type 值（如 read_file、write_file、list_dir、shell、glob、grep 等）
- 参数名必须与工具定义中的一致`;

/**
 * 原生函数调用提示词（C3-M2）：这些 provider 的适配器已把 tools 下发进请求体，
 * 若仍强制 <tool_call> 文本格式会与原生 schema 冲突 → 模型双重输出/乱码（实测 DeepSeek V4 Flash）。
 */
export const XUANCODE_TOOL_PROMPT_NATIVE = `## 工具调用（原生函数调用）
- 工具已通过原生 function calling（tools 参数，含完整参数 schema）提供。
- 需要调用工具时，请直接发起函数调用（tool_calls），不要在正文中输出 <tool_call> 文本标记或 JSON。
- 每次只调用一个工具，等待工具结果返回后再决定下一步。
- 工具结果会以 role:"tool" 消息返回给你。`;

export const XUANCODE_SYSTEM_PROMPT_BASE = `${XUANCODE_SYSTEM_PROMPT_CORE}\n\n${XUANCODE_TOOL_PROMPT_TEXT}`;

/** 原生工具提示词白名单：与 model-router 阵营 A 适配器（openai/deepseek/qwen/zhipu/volcengine）+
 *  阵营 B anthropic（M3 富结构原生通道）一致；
 *  Ollama 在模型注册表中 supportsToolCalling=false，保持文本格式兜底；
 *  google（Gemini）M4 落地时加入。 */
const NATIVE_TOOL_PROVIDERS = new Set([
	"openai",
	"deepseek",
	"qwen",
	"zhipu",
	"volcengine",
	"anthropic",
	"google",
]);

export interface TaorLoopOptions {
	model: ModelAdapter;
	workDir: string;
	config?: Partial<AgentConfig>;
	systemPrompt?: string;
	abortSignal?: AbortSignal;
	attachments?: AttachmentBlock[];
	/** 前置消息历史（同一 session 内多轮输入），用于保持对话连续性 */
	messages?: Message[];
	onTurn?: (turn: number, state: Readonly<AgentState>) => void;
	onToolCall?: (tc: any, result: ToolResult) => void;
	onError?: (message: string, site: string) => void;
	/** Stream token callback for real-time UI display */
	onToken?: (token: string, fullText: string) => void;
	/** Progress summary callback — called each turn after tools execute */
	onProgress?: (info: {
		turn: number;
		summary: string;
		toolCallCount: number;
	}) => void;
	/** Hook callback for lifecycle events (wired by caller to avoid circular deps) */
	onHook?: (event: string, context: Record<string, unknown>) => void;
	/** Optional telemetry tracer for observability (performance, no-op if unset) */
	tracer?: Tracer;
	/** Enable dynamic workflow capability. When true, workflow tools are auto-registered
	 *  and workflow state is injected into the system prompt each turn.
	 *  When false (default), the loop behaves exactly as before. */
	enableWorkflow?: boolean;
	/** Optional pre-configured workflow plan manager (e.g., seeded from DAG decomposition).
	 *  If enableWorkflow is true and this is not provided, one is created internally. */
	workflowManager?: WorkflowPlanManager;
	/** Extra tool definitions to register after defaults (e.g. semantic_search) */
	extraDefinitions?: Array<{
		def: ToolDef;
		handler: (params: ToolCallParams) => Promise<ToolResult>;
	}>;
	/** 推理强度 — 透传给 ModelRouter.setReasoningLevel()，由各适配器翻译为原生参数 */
	reasoningLevel?: "fast" | "medium" | "expert";
	/** 插件工具 handler 覆盖 — key 为 tool type，优先级高于内置 ToolManager */
	extraHandlerOverrides?: Record<
		string,
		(params: ToolCallParams) => Promise<ToolResult>
	>;
	/** 五行 · 用户确认回调。当工具调用需要用户确认时调用。
	 *  回调返回 true 则放行，false 则拒绝。 */
	onPermissionRequest?: (
		tc: ToolCallParams,
		decision: { requireConfirm: boolean; reason: string; risk?: any },
	) => Promise<boolean>;
	/** 程序化验证 gate 事件回调（verifyMode === "auto"）：gate 拦截 / 验证通过 / 重试到顶失败时上报，供前端展示验证横幅 */
	onVerifyGate?: (info: {
		type:
			| "gate_blocked"
			| "verify_passed"
			| "goal_blocked"
			| "goal_passed"
			| "verify_failed"
			| "goal_failed";
		message: string;
		command?: string;
		rounds: number;
	}) => void;
	/** 断点续跑（B3）：显式 resume 上下文（由调用方以 resumeTaskId 门控）。
	 *  续跑只播种 transcript + 状态，从最后一条消息继续，绝不复放已执行的工具历史。 */
	resume?: {
		messages: Message[];
		turnCount: number;
		checkpoint: ProjectCheckpointSnapshot;
	};
	/** 断点快照的标识（通常为 taskId），用于 .xuancode/resume-<resumeId>.json 的每轮持久化。 */
	resumeId?: string;
}

export interface TaorLoopResult {
	finalAnswer: string;
	turnCount: number;
	stopReason: StopReason;
	duration: number;
	toolCallCount: number;
	errorCount: number;
	contextUsage: number;
}

/**
 * TAOR Loop v2 — Think → Act → Observe → Repeat
 *
 * Enhanced with:
 * - 7 continue sites for error recovery
 * - Streaming tool executor
 * - Abort signal support
 * - Context budget tracking
 * - Callback hooks for UI updates
 */
export async function runTaorLoop(
	userInput: string,
	options: TaorLoopOptions,
): Promise<TaorLoopResult> {
	const startTime = performance.now();

	// 透传推理强度到 ModelRouter（若支持）
	if (
		options.reasoningLevel &&
		typeof (options.model as any).setReasoningLevel === "function"
	) {
		(options.model as any).setReasoningLevel(options.reasoningLevel);
	}

	const maxTurns = options.config?.maxTurns ?? 50;
	const maxContinuations = options.config?.maxContinuations ?? 0;
	let continuationCount = 0;
	let budgetWarned = false;
	// 进度摘要统计（2.2）：文件读取/写入去重，搜索与命令计数
	const filesRead = new Set<string>();
	const filesWritten = new Set<string>();
	let searchesCount = 0;
	let shellsCount = 0;
	// V5 死循环检测：滑窗记录最近 N 次 tool_call 签名，同一签名命中 ≥3 次即 abort
	const LOOP_WINDOW = 6;
	const LOOP_THRESHOLD = 3;
	const recentToolSignatures: string[] = [];
	let loopDetected = false;
	let loopSignature = "";
	const toolManager = new ToolManager(options.workDir, options.config?.mode);

	// 项目 checkpoint + 程序化验证 gate（启动时续接已有 checkpoint，跨任务累积项目状态）
	const checkpoint = options.workDir
		? ProjectCheckpoint.fromFile(options.workDir)
		: new ProjectCheckpoint();
	// B3 断点续跑：用 resume 快照覆盖文件 checkpoint（续跑以显式传入的 resume 为准）
	if (options.resume) {
		checkpoint.seed(options.resume.checkpoint);
	}
	const verifyMode = options.config?.verifyMode ?? "off";
	const verifyCommand = options.config?.verifyCommand?.trim() || undefined;
	const maxVerifyRounds = options.config?.maxVerifyRounds ?? 3;
	let verifyGateBlocks = 0;
	// C2 · 目标闭环（goalMode）：在 verifyMode === "auto" 之上叠加验收标准，
	// 未达标则注入失败原因继续修复，达标（验证通过）或达重试上限才结束。
	const goalMode = options.config?.goalMode === true && verifyMode === "auto";
	const goalCriterion = options.config?.goalCriterion?.trim() || "";
	const goalMaxRounds = options.config?.goalMaxRounds ?? 3;
	let goalGateBlocks = 0;

	// 五行 · 用户确认：将上层回调注入 ToolManager
	if (options.onPermissionRequest) {
		const onPermissionRequest = options.onPermissionRequest;
		toolManager.onPermissionConfirm = async (toolType, params, decision) => {
			return onPermissionRequest(params as any, {
				requireConfirm: decision.requireConfirm,
				reason: decision.reason,
				risk: decision.risk,
			});
		};
	}

	// 注册额外工具（如 semantic_search）
	if (options.extraDefinitions) {
		for (const ext of options.extraDefinitions) {
			toolManager.define(ext.def, ext.handler as any);
		}
	}

	// ===== 动态工作流初始化 =====
	const workflowManager =
		options.workflowManager ??
		(options.enableWorkflow
			? new WorkflowPlanManager({
					onEvent: (event) => {
						options.onHook?.(
							"WorkflowEvent",
							event as unknown as Record<string, unknown>,
						);
					},
				})
			: undefined);

	// 注册工作流工具到 ToolManager（使模型感知这些工具）
	if (workflowManager) {
		const workflowTools = createWorkflowToolDefinitions(
			workflowManager,
			toolManager,
		);
		for (const wt of workflowTools) {
			toolManager.define(wt.def as ToolDef, wt.handler as any);
		}
	}

	// 生成 OpenAI 兼容 tools 定义，使模型原生感知工具能力（防止拒绝）
	const apiTools: ApiToolDefinition[] = toApiTools(
		toolManager.getDefinitions(),
	);

	// 静态系统提示词（缓存在 cache boundary 之上）
	// C3-M2：provider 已原生下发 tools 时改用原生函数调用提示词，避免 <tool_call> 文本格式与原生 schema 冲突导致乱码/双重输出
	const useNativeTools =
		apiTools.length > 0 && NATIVE_TOOL_PROVIDERS.has(options.model.provider);
	let basePrompt =
		options.systemPrompt ||
		(useNativeTools
			? `${XUANCODE_SYSTEM_PROMPT_CORE}\n\n${XUANCODE_TOOL_PROMPT_NATIVE}`
			: `${XUANCODE_SYSTEM_PROMPT_BASE}\n\n${toolManager.generateToolPrompt()}`);
	// C2 · 目标闭环：注入验收标准，要求模型达标后再结束任务
	if (goalMode && goalCriterion) {
		basePrompt += `\n\n[任务验收标准]\n${goalCriterion}\n在完成任务后，必须确保该标准得到满足再总结结束；若标准包含测试/构建/lint 命令，请务必执行并确认通过。未达标时，根据失败原因继续修复，不得直接结束任务。`;
	}

	// 水 · 智水 — 加载六层记忆注入上下文
	let memoryPrompt = "";
	try {
		const memoryManager = new MemoryManager(options.workDir);
		await memoryManager.loadAll();
		memoryPrompt = memoryManager.buildMemoryPrompt(userInput);
	} catch {
		// Memory layer failure is non-fatal — continue without memory
	}

	// 缓存边界 — 静态内容（身份+工具列表）在上，动态内容（记忆+轮次）在下
	const cacheBoundary = new CacheBoundaryManager();
	const systemPrompt = cacheBoundary.buildSystemPrompt(basePrompt, {
		memory: memoryPrompt || "(无)",
	});

	// Session start hook
	options.onHook?.("SessionStart", {
		timestamp: Date.now(),
		workDir: options.workDir,
	});

	// Telemetry: start trace
	options.tracer?.startTrace(userInput);

	const stateManager = new StateManager({
		// B3 续跑：直接预置 resume.transcript（含原始用户输入与已执行工具历史），
		// 不复用本轮 userInput 追加消息，避免重复；轮次预算 = 已用轮数 + 本轮上限。
		messages: options.resume
			? [...options.resume.messages]
			: [
					...(options.messages || []),
					{
						role: "user",
						content: userInput,
						...(options.attachments?.length
							? { attachments: options.attachments }
							: {}),
					},
				],
		turnCount: options.resume?.turnCount ?? 0,
		maxTurns: maxTurns + (options.resume?.turnCount ?? 0),
		startTime,
	});

	let finalAnswer = "";
	let toolCallCount = 0;
	let currentTurnSpanId: string | null | undefined = null;

	while (true) {
		stateManager.incrementTurn();

		// ===== 2.1 轮次预算预警 =====
		// 接近 maxTurns 上限时注入收敛提示，引导模型评估剩余工作量
		const curState = stateManager.getState();
		const warnThreshold = Math.floor(curState.maxTurns * 0.75);
		if (
			!budgetWarned &&
			curState.turnCount >= warnThreshold &&
			warnThreshold >= 1
		) {
			budgetWarned = true;
			stateManager.addMessage({
				role: "user",
				content: `(⚠️ 已使用 ${curState.turnCount}/${curState.maxTurns} 轮。请评估剩余工作量：若接近完成直接输出最终总结；若未完成只做最关键的一步，避免重复读取/搜索。)`,
			});
		}

		stateManager.snapshot();

		// Telemetry: turn start
		options.tracer?.incrementTurn();
		currentTurnSpanId = options.tracer?.startSpan(
			`turn-${stateManager.getState().turnCount}`,
			"turn",
			"none",
			null,
		)?.id;

		// ===== 水 · 智水: Context Compression Check =====
		// Progressive compaction before context overflow: snip → microCompact → collapse
		// Escalates compression level based on context usage severity
		const maxLevel = options.config?.compactLevel ?? CompactLevel.SNIP;
		const compactThreshold = options.config?.compactThreshold ?? 0.7;
		const usage = stateManager.getContextUsage();
		if (maxLevel > 0 && usage > compactThreshold * 100) {
			try {
				// Determine target level: more aggressive as usage increases
				let targetLevel = CompactLevel.SNIP;
				if (usage > 93 && maxLevel >= CompactLevel.CONTEXT_COLLAPSE) {
					targetLevel = CompactLevel.CONTEXT_COLLAPSE;
				} else if (usage > 85 && maxLevel >= CompactLevel.MICRO_COMPACT) {
					targetLevel = CompactLevel.MICRO_COMPACT;
				} else if (usage > 78 && maxLevel >= CompactLevel.MICRO_COMPACT) {
					targetLevel = CompactLevel.SNIP;
				}
				// Apply configured level if higher than usage-based selection
				if (maxLevel > targetLevel) targetLevel = maxLevel;

				const currentMessages = [
					...(stateManager.getState() as AgentState).messages,
				];
				const compressed = compactMessages(
					currentMessages,
					targetLevel as CompactLevel,
				);
				if (compressed.length < currentMessages.length) {
					const compactSpanId = options.tracer?.startSpan(
						"compression",
						"compression",
						"none",
						currentTurnSpanId,
					)?.id;
					stateManager.replaceMessages(compressed);
					stateManager.resetBudget();
					// 压缩后注入项目状态摘要，防止长任务丢失「改到哪了」的关键进度
					const cpAfterCompress = checkpoint.summary();
					if (cpAfterCompress) {
						stateManager.addMessage({ role: "user", content: cpAfterCompress });
					}
					options.tracer?.endSpan(compactSpanId!, "ok", {
						beforeCount: currentMessages.length,
						afterCount: compressed.length,
						compactLevel: targetLevel,
					});
				}
			} catch (e: any) {
				// Continue Site: COMPACT_FAILURE — non-fatal, skip compression
				options.onError?.(`上下文压缩失败: ${e.message}`, "compact_failure");
			}
		}

		const state = stateManager.getState();

		// Check abort signal
		if (options.abortSignal?.aborted) {
			stateManager.setStopReason(StopReason.ABORT);
			finalAnswer = "❖ 用户已取消操作";
			break;
		}

		// ===== 1. Stop Condition Check =====
		const stopReason = checkStopConditions(state);
		if (stopReason !== null) {
			stateManager.setStopReason(stopReason);
			if (stopReason === StopReason.MAX_TURNS) {
				// 1.4 自动续跑：未达到 maxContinuations 上限时追加轮次预算继续执行
				if (continuationCount < maxContinuations) {
					continuationCount++;
					stateManager.extendTurns(maxTurns);
					stateManager.resetConsecutiveErrors();
					budgetWarned = false; // 每段独立预警一次
					options.onHook?.("ContinuationStart", {
						continuationCount,
						maxContinuations,
						maxTurns: stateManager.getState().maxTurns,
					});
					checkpoint.recordMilestone(
						`自动续跑第 ${continuationCount}/${maxContinuations} 段`,
					);
					const cpLine = checkpoint.summary();
					stateManager.addMessage({
						role: "user",
						content: `(已运行 ${stateManager.getState().turnCount} 轮仍未完成，已自动续跑第 ${continuationCount}/${maxContinuations} 段。${cpLine ? `${cpLine}。` : ""}请继续推进剩余工作，不要重复已完成的操作。大文件请用 read_file 配合 start_line/end_line 分块读取。)`,
					});
					continue;
				}
				finalAnswer += "\n⚠️ 达到最大执行轮次,任务可能未完成";
				break;
			}
			if (stopReason === StopReason.CONTEXT_OVERFLOW) {
				finalAnswer += "\n⚠️ 上下文预算耗尽,强制终止";
				break;
			}
			if (stopReason === StopReason.ERROR) {
				finalAnswer += `\n⚠️ ${state.error?.message || "连续错误过多,终止执行"}`;
				break;
			}
			if (
				stopReason === StopReason.HOOK_STOP ||
				stopReason === StopReason.ABORT
			)
				break;
			if (stopReason === StopReason.NO_TOOL_USE) {
				// 上轮模型直接应答（多为验证 gate 拦截后注入指引）：不在此终止，落到下方模型调用，
				// 让模型按 gate 指引执行验证后再收尾；正常直接应答在下方 PARSE 段处理并终结。
			} else {
				break;
			}
		}

		options.onTurn?.(state.turnCount, state);

		// ===== 2. THINK: Call Model (streaming) =====
		let rawResponse: string;
		// M3 富结构通道：本轮流式产出的结构化原生工具调用（阵营 B；Camp A 仍走文本注入解析）
		let nativeToolCalls: NativeToolCall[] | undefined;
		const modelSpanId = options.tracer?.startSpan(
			"model-call",
			"model_call",
			"none",
			currentTurnSpanId,
		)?.id;
		try {
			// Stream tokens for real-time UI display + full response accumulation
			let streamingBuffer = "";
			// 如果有工作流管理器，在工作流消息前注入工作流状态提示
			let turnMessages = state.messages;
			const workflowPrompt = workflowManager?.toSystemPromptSection();
			if (workflowPrompt) {
				turnMessages = [
					{ role: "system" as const, content: workflowPrompt },
					...state.messages,
				];
			}
			const generator = options.model.chatStream(
				turnMessages,
				systemPrompt,
				apiTools,
			);
			// 富结构流式（M3 阵营 B）：文本增量(string) 累积进 streamingBuffer；
			// 结构化工具调用事件（{type:"tool_calls"}）直接收集，不经过 content 文本 → 无注入/剥离负担。
			// Camp A 的 JSON 行注入仍在流尾追加文本，靠 stripNativeToolJson 剔除（兼容保留）。
			for await (const token of generator) {
				if (typeof token === "string") {
					streamingBuffer += token;
					// 原生工具 JSON 行注入在 finish_reason 时追加到流尾：仅当出现 "id":"call_" 标记才做剔除，
					// 避免泄漏到用户可见的流式文本（无 <tool_call> 标签，stripToolCalls 剥不掉）
					options.onToken?.(
						token,
						streamingBuffer.includes('"id":"call_')
							? stripNativeToolJson(streamingBuffer)
							: streamingBuffer,
					);
				} else {
					nativeToolCalls = token.toolCalls;
				}
			}
			rawResponse = streamingBuffer;
			// 注意：consecutiveErrors 的重置移到空响应判断之后，空响应才会累计计数（见下方）
			// Telemetry: end model call span
			options.tracer?.endSpan(modelSpanId!, "ok", {
				responseLength: rawResponse.length,
				turns: stateManager.getState().turnCount,
			});
		} catch (err: any) {
			// Continue Site 1: Model API call failed
			options.tracer?.endSpan(modelSpanId!, "error", { error: err.message });
			stateManager.addError(err.message, true);
			options.onError?.(err.message, ContinueSite.MODEL_CALL);
			const recovery = getRecovery(
				ContinueSite.MODEL_CALL,
				stateManager.getState() as AgentState,
				err,
			);
			if (!recovery.shouldContinue) {
				finalAnswer = recovery.recoveryMessage || "模型调用失败";
				stateManager.setStopReason(recovery.stopReason || StopReason.ERROR);
				break;
			}
			if (recovery.recoveryMessage) {
				stateManager.addMessage({
					role: "user",
					content: recovery.recoveryMessage,
				});
			}
			continue;
		}

		let cleanResponse = stripThinkContent(rawResponse);

		// Continue Site 2: Empty response
		// （M3 富结构：模型可能只产出结构化工具调用而无任何文本 → 有 structured toolCalls 不算空响应）
		if (!cleanResponse && !(nativeToolCalls && nativeToolCalls.length > 0)) {
			// 推理模型可能把工具调用留在推理标签内导致剥离后为空 → 先从原始输出恢复工具调用
			const rawToolCalls = parseAllToolCalls(rawResponse);
			if (rawToolCalls.length > 0) {
				cleanResponse = rawToolCalls.map((tc) => JSON.stringify(tc)).join("\n");
			} else {
				stateManager.addError("模型返回空响应", true);
				options.onError?.("模型返回空响应", ContinueSite.EMPTY_RESPONSE);
				const recovery = getRecovery(
					ContinueSite.EMPTY_RESPONSE,
					stateManager.getState() as AgentState,
					"empty",
				);
				if (!recovery.shouldContinue) {
					finalAnswer = recovery.recoveryMessage || "模型返回空响应";
					stateManager.setStopReason(recovery.stopReason || StopReason.ERROR);
					break;
				}
				if (recovery.recoveryMessage) {
					stateManager.addMessage({
						role: "user",
						content: recovery.recoveryMessage,
					});
				}
				continue;
			}
		}

		// 非空响应视为模型调用成功，重置连续错误计数（空响应不重置，用于 3 次后终止）
		stateManager.resetConsecutiveErrors();

		// ===== 3. PARSE: Extract tool calls (support multiple per turn) =====
		let toolCalls = parseAllToolCalls(cleanResponse);
		// M3 富结构通道优先：结构化原生工具调用（{type:"tool_calls"} 事件）是权威来源，
		// 直接构造 ToolCallParams（带原生 id），不再依赖文本正则解析；模型正文（如有）仅作对话上下文。
		if (nativeToolCalls && nativeToolCalls.length > 0) {
			toolCalls = nativeToolCalls.map((tc) => {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.arguments);
				} catch {
					/* 参数非合法 JSON → 空参数 */
				}
				return { ...args, type: tc.name, id: tc.id } as ToolCallParams;
			});
		}
		// M1(C3) 原生 Tool Calling 识别：streamParser 在 finish_reason=tool_calls 时注入的 JSON 行携带原生
		// tool_call 的 id → 原生路径（assistant 携带结构化 toolCalls + role:"tool" 结果回灌）；无 id → 文本路径（现状）
		const isNativeToolCalls =
			toolCalls.length > 0 &&
			toolCalls.some(
				(t) =>
					typeof (t as ToolCallParams).id === "string" &&
					(t as ToolCallParams).id,
			);
		// 防御：模型偶发把同一原生调用以文本形式重复输出（同 id 重复）→ 去重防止重复执行
		if (isNativeToolCalls) {
			const seenIds = new Set<string>();
			toolCalls = toolCalls.filter((t) => {
				const id = String((t as ToolCallParams).id || "");
				if (!id) return true;
				if (seenIds.has(id)) return false;
				seenIds.add(id);
				return true;
			});
		}
		const toolCallsMeta: NativeToolCall[] | undefined = isNativeToolCalls
			? toolCalls.map((t) => {
					const { type, id, ...args } = t as any;
					return {
						id: String(id),
						name: type,
						arguments: JSON.stringify(args),
					};
				})
			: undefined;

		stateManager.addMessage({
			role: "assistant",
			// 工具调用是控制面产物，不入库、不显示：文本 <tool_call> 残留与原生 JSON 行
			// 都从存储的正文剔除（正文直接输出 <tool_call 的根源在文本路径此前不剥标签），
			// 本轮解析用未剥离的 cleanResponse（上方 toolCalls 已取）。
			content: stripToolCalls(
				isNativeToolCalls ? stripNativeToolJson(cleanResponse) : cleanResponse,
			),
			...(toolCallsMeta ? { toolCalls: toolCallsMeta } : {}),
		});

		// 滑动窗口压缩：超过 15 轮时自动压缩早期消息；AUTO_COMPACT 级改用语义摘要并注入项目状态
		if (maxLevel >= CompactLevel.AUTO_COMPACT) {
			try {
				stateManager.compressWithSummary(checkpoint.summary());
			} catch (e: any) {
				// 语义摘要失败 → 回退到截断压缩，不中断任务
				stateManager.compress();
			}
		} else {
			stateManager.compress();
		}

		if (toolCalls.length === 0) {
			// 模型输出含工具调用标签但解析失败 → 格式幻觉（<tool_calls> 复数、嵌套 XML 混排等）。
			// 注入重试指引让模型重新按标准格式输出，而不是把原始标签垃圾作为最终答案显示。
			if (hasToolCallArtifacts(cleanResponse)) {
				stateManager.addError("工具调用格式无法解析", true);
				options.onError?.("工具调用格式无法解析，注入重试指引", "tool_parse");
				if (stateManager.getState().consecutiveErrors >= 2) {
					// 连续格式错误，终止并给出剥离标签后的可读文本
					finalAnswer =
						stripToolCalls(cleanResponse) ||
						"模型连续输出无法解析的工具调用格式，已终止执行。";
					stateManager.setStopReason(StopReason.ERROR);
					break;
				}
				stateManager.addMessage({
					role: "user",
					content: useNativeTools
						? "(你输出的工具调用格式无法解析。请直接使用原生函数调用（tool_calls）发起工具调用，不要在正文中输出 <tool_call> 文本标记或 JSON。每次只调用一个工具，等待结果后再决定下一步。)"
						: '(你输出的工具调用格式无法解析。请改用标准格式：\n<tool_call>\n{"type":"工具名称","参数名":"参数值"}\n</tool_call>\n每次只调用一个工具，等待结果后再决定下一步。)',
				});
				continue;
			}
			// No tool call = model responding directly → complete（先过验证 gate；goalMode 叠加验收标准）
			if (verifyMode === "auto") {
				if (goalMode && goalCriterion) {
					// C2 · 目标闭环：未达标则注入失败原因继续修复，直到验证通过或达重试上限
					const goalMet = checkpoint.verifyState?.passed === true;
					if (!goalMet) {
						if (goalGateBlocks < goalMaxRounds) {
							goalGateBlocks++;
							const errs = checkpoint.verifyState?.lastOutput
								? extractVerifyErrors(checkpoint.verifyState.lastOutput, 8)
								: "";
							const errSection = errs ? `\n关键错误：\n${errs}\n` : "\n";
							const msg =
								`(🎯 目标闭环：验收标准「${goalCriterion}」尚未满足。${errSection}` +
								`请继续修复并重新验证，直到标准达标（验证通过）后再总结，不要直接结束任务。已尝试 ${goalGateBlocks}/${goalMaxRounds} 轮。)`;
							options.onVerifyGate?.({
								type: "goal_blocked",
								message: msg,
								command: verifyCommand,
								rounds: goalGateBlocks,
							});
							stateManager.addMessage({ role: "user", content: msg });
							continue;
						}
						// 达重试上限 → 显式失败（不静默放行伪装成功）：附验收标准 + 关键错误摘要
						const goalErrs = checkpoint.verifyState?.lastOutput
							? extractVerifyErrors(checkpoint.verifyState.lastOutput, 8)
							: "";
						const goalFailSummary = [
							`⚠️ 任务未达标：已达目标重试上限（${goalMaxRounds} 轮），验收标准「${goalCriterion}」未能确认满足。`,
							goalErrs ? `最近验证的关键错误：\n${goalErrs}` : "",
							"以下为模型最后一轮输出（未经验证通过，请人工复核）：",
						]
							.filter(Boolean)
							.join("\n\n");
						options.onVerifyGate?.({
							type: "goal_failed",
							message: `已达目标重试上限（${goalMaxRounds} 轮），验收标准「${goalCriterion}」未能确认满足，任务显式结束。`,
							command: verifyCommand,
							rounds: goalGateBlocks,
						});
						finalAnswer = `${stripToolCalls(cleanResponse) || cleanResponse}\n\n---\n${goalFailSummary}`;
						stateManager.setStopReason(StopReason.VERIFY_FAILED);
						break;
					}
					options.onVerifyGate?.({
						type: "goal_passed",
						message: `验收标准「${goalCriterion}」已满足（验证通过），任务达标结束。`,
						command: verifyCommand,
						rounds: goalGateBlocks,
					});
				} else {
					const gate = evaluateVerifyGate({
						mode: verifyMode,
						modified: checkpoint.modifiedCount,
						verify: checkpoint.verifyState,
						command: verifyCommand,
						maxFixRounds: maxVerifyRounds,
						gateBlocks: verifyGateBlocks,
					});
					if (gate.block) {
						verifyGateBlocks++;
						options.onVerifyGate?.({
							type: "gate_blocked",
							message: gate.message,
							command: verifyCommand,
							rounds: verifyGateBlocks,
						});
						stateManager.addMessage({ role: "user", content: gate.message });
						continue;
					}
					const vs = checkpoint.verifyState;
					const passed = vs?.passed === true;
					if (passed) {
						options.onVerifyGate?.({
							type: "verify_passed",
							message: "验证通过，任务正常结束。",
							command: verifyCommand,
							rounds: verifyGateBlocks,
						});
					} else if (vs?.ran || checkpoint.modifiedCount > 0) {
						// 重试到顶仍未通过/未验证 → 显式失败（不静默放行伪装成功）：附关键错误摘要
						const neverRan = !vs?.ran;
						const gateErrs =
							vs?.lastOutput && !neverRan
								? extractVerifyErrors(vs.lastOutput, 8)
								: "";
						const failSummary = [
							neverRan
								? "⚠️ 任务未达标：代码已修改但从未执行验证，达到拦截次数上限，任务显式结束。"
								: `⚠️ 任务未达标：验证已尝试 ${vs?.rounds ?? 0} 次仍未通过，达到重试上限，任务显式结束。`,
							gateErrs ? `最近验证的关键错误：\n${gateErrs}` : "",
							"以下为模型最后一轮输出（未经验证通过，请人工复核）：",
						]
							.filter(Boolean)
							.join("\n\n");
						options.onVerifyGate?.({
							type: "verify_failed",
							message: neverRan
								? "代码已修改但从未执行验证，达到拦截次数上限，任务显式结束。"
								: `验证已尝试 ${vs?.rounds ?? 0} 次未通过，达到重试上限，任务显式结束。`,
							command: verifyCommand,
							rounds: verifyGateBlocks,
						});
						finalAnswer = `${stripToolCalls(cleanResponse) || cleanResponse}\n\n---\n${failSummary}`;
						stateManager.setStopReason(StopReason.VERIFY_FAILED);
						break;
					}
				}
			}
			finalAnswer = stripToolCalls(cleanResponse) || cleanResponse;
			stateManager.setStopReason(StopReason.NO_TOOL_USE);
			break;
		}

		stateManager.setLastToolCall(toolCalls[0] as any);
		stateManager.consumeBudget(cleanResponse.length);

		// ===== 4. ACT: Execute all tools sequentially =====
		const allResults: ToolResult[] = [];
		let anyError = false;

		for (const tc of toolCalls) {
			// V5 死循环检测：相同 tool_call 签名在滑窗内命中 ≥3 次即 abort
			const sig = `${tc.type}::${JSON.stringify(tc)}`;
			const hits = recentToolSignatures.filter((s) => s === sig).length;
			if (hits + 1 >= LOOP_THRESHOLD) {
				loopDetected = true;
				loopSignature = sig;
				options.onError?.(
					`检测到工具调用死循环: ${tc.type} 已连续重复 ${hits + 1} 次，自动终止以避免空转`,
					"loop_detected",
				);
				break;
			}
			recentToolSignatures.push(sig);
			if (recentToolSignatures.length > LOOP_WINDOW)
				recentToolSignatures.shift();

			let toolResult: ToolResult;

			// Pre-tool hook
			options.onHook?.("PreToolUse", { toolType: tc.type, toolParams: tc });

			// Telemetry: tool call span
			const toolKind: any = tc.type?.startsWith("mcp_")
				? "mcp_call"
				: "tool_call";
			const toolSpanId = options.tracer?.startSpan(
				tc.type,
				toolKind,
				"none",
				currentTurnSpanId,
			)?.id;

			try {
				// 插件工具 handler 优先于内置 ToolManager
				const overrideHandler = options.extraHandlerOverrides?.[tc.type];
				if (overrideHandler) {
					toolResult = await overrideHandler(tc);
				} else {
					toolResult = await toolManager.dispatch(tc);
				}
			} catch (err: any) {
				// Continue Site 4: Tool execution threw exception
				stateManager.addError(err.message, true);
				const recovery = getRecovery(
					ContinueSite.TOOL_EXECUTION,
					stateManager.getState() as AgentState,
					err,
				);
				toolResult = {
					success: false,
					data: "",
					error: recovery.recoveryMessage || err.message,
				};
			}

			if (!toolResult.success) {
				stateManager.addError(toolResult.error || "工具执行失败", false);
				anyError = true;
				options.onHook?.("PostToolUseFailure", {
					toolType: tc.type,
					error: toolResult.error,
				});
				options.tracer?.endSpan(toolSpanId!, "error", {
					error: toolResult.error,
				});
			} else {
				stateManager.resetConsecutiveErrors();
				options.onHook?.("PostToolUse", { toolType: tc.type, success: true });
				options.tracer?.endSpan(toolSpanId!, "ok", {
					dataLength: toolResult.data?.length ?? 0,
				});
			}

			stateManager.setLastToolResult(toolResult);
			toolCallCount++;
			options.onToolCall?.(tc, toolResult);
			allResults.push(toolResult);

			// 2.2 进度统计：文件读取/写入去重，搜索/命令计数
			const tPath = (tc as any).path;
			if (tc.type === "read_file" && tPath) {
				filesRead.add(String(tPath));
				checkpoint.recordRead(String(tPath));
			} else if (tc.type === "read_files") {
				for (const p of (tc as any).paths || []) {
					filesRead.add(String(p));
					checkpoint.recordRead(String(p));
				}
			} else if (tc.type === "write_file" || tc.type === "edit_file") {
				if (tPath) {
					filesWritten.add(String(tPath));
					checkpoint.recordWrite(String(tPath));
				}
			} else if (tc.type === "grep" || tc.type === "glob") {
				searchesCount++;
			} else if (tc.type === "shell") {
				shellsCount++;
				// 验证命令执行结果 → 更新验证状态
				const shellCmd = String(
					tc.params?.command || tc.params?.cmd || tc.command || tc.cmd || "",
				);
				if (isVerifyCommand(shellCmd)) {
					const wasPassed = checkpoint.verifyState.passed;
					const passed = toolResult.success;
					checkpoint.recordVerify({
						ran: true,
						passed,
						rounds: passed ? 0 : checkpoint.verifyState.rounds + 1,
						lastCommand: shellCmd.slice(0, 200),
						lastOutput: passed
							? undefined
							: String(toolResult.data || "").slice(0, 4000),
					});
					// 首次验证通过 → 记录关键节点
					if (passed && !wasPassed) {
						checkpoint.recordMilestone(`验证通过: ${shellCmd.slice(0, 60)}`);
					}
				}
			}
		}

		// V5 死循环检测：命中即终止，不注入本轮回收的工具结果（避免模型继续空转）
		if (loopDetected) {
			finalAnswer = `⚠️ 检测到工具调用死循环，已自动终止以避免空转。\n重复签名: ${loopSignature.slice(0, 200)}\n已完成 ${stateManager.getState().turnCount} 轮 / ${toolCallCount} 次工具调用。建议：换用 read_file 配合 start_line/end_line 分块读取，或换一种思路推进。`;
			stateManager.setStopReason(StopReason.LOOP_DETECTED);
			break;
		}

		// Continue Site 5: Check if all tools failed
		if (anyError) {
			const errors = allResults
				.filter((r) => !r.success)
				.map((r) => r.error)
				.join("; ");
			const recovery = getRecovery(
				ContinueSite.TOOL_ERROR,
				stateManager.getState() as AgentState,
				errors,
			);
			if (!recovery.shouldContinue) {
				finalAnswer = `工具执行失败: ${errors}`;
				stateManager.setStopReason(recovery.stopReason || StopReason.ERROR);
				break;
			}
		}

		// ===== 2.2 进度摘要 =====
		if (options.onProgress) {
			options.onProgress({
				turn: stateManager.getState().turnCount,
				summary: `已读 ${filesRead.size} 文件 · 已改 ${filesWritten.size} 文件 · 搜索 ${searchesCount} 次 · 执行命令 ${shellsCount} 次`,
				toolCallCount,
			});
		}

		// ===== 5. OBSERVE: Inject all results =====
		if (isNativeToolCalls) {
			// M1(C3) 原生回灌：每条工具结果独立 role:"tool" 消息，tool_call_id 对齐原生 assistant.tool_calls
			toolCalls.forEach((tc, i) => {
				const r = allResults[i];
				const combined = {
					_toolIndex: i,
					success: r.success,
					// 编译/测试输出走专用截断：优先保留可修复错误行；其余走通用截断
					data: truncateCompileOutput(r.data, 6000, (o, m) =>
						smartTruncate(o, m),
					),
					error: r.error,
				};
				const content = JSON.stringify(combined);
				stateManager.addMessage({
					role: "tool",
					content,
					tool_call_id: String((tc as ToolCallParams).id),
				});
				stateManager.consumeBudget(content.length);
			});
		} else {
			const combinedResults = allResults.map((r, i) => ({
				_toolIndex: i,
				success: r.success,
				// 编译/测试输出走专用截断：优先保留可修复错误行；其余走通用截断
				data: truncateCompileOutput(r.data, 6000, (o, m) =>
					smartTruncate(o, m),
				),
				error: r.error,
			}));
			const resultContent = `工具结果: ${JSON.stringify(combinedResults)}`;
			stateManager.addMessage({ role: "user", content: resultContent });
			stateManager.consumeBudget(resultContent.length);
		}

		// ===== 6. WORKFLOW: Check if workflow plan is complete =====
		if (workflowManager?.isComplete()) {
			finalAnswer = `${workflowManager.getPlan()?.summary}\n\n✅ 所有工作流步骤已完成。`;
			stateManager.setStopReason(StopReason.WORKFLOW_COMPLETE);
			break;
		}

		// ===== 7. B3 断点持久化：每轮结束保存 checkpoint + resume 快照（崩溃后续跑）=====
		if (options.workDir) {
			try {
				const st = stateManager.getState();
				checkpoint.recordPlan(workflowManager?.getPlan() as any);
				checkpoint.setTurns(st.turnCount);
				checkpoint.save(options.workDir);
				if (options.resumeId) {
					writeResumeState(options.workDir, options.resumeId, {
						version: 1,
						// 完整 transcript（stateManager 压缩已约束大小；400 条只是防极端的兜底，不再是 60 条截断）
						messages: st.messages.slice(-400),
						turnCount: st.turnCount,
						stopReason: st.stopReason ?? undefined,
						// 工作流计划快照：续跑精确恢复步骤状态，不重新分解
						plan: (workflowManager?.getPlan() as any) ?? null,
						updatedAt: Date.now(),
					});
				}
			} catch {
				/* 断点持久化失败不影响任务 */
			}
		}
	}

	const duration = performance.now() - startTime;
	const finalState = stateManager.getState();

	// 项目 checkpoint 落盘（观测 + 断点恢复）：记录工作流计划快照后持久化
	const finalPlan = workflowManager?.getPlan();
	if (finalPlan) checkpoint.recordPlan(finalPlan as any);
	checkpoint.setTurns(finalState.turnCount);
	checkpoint.save(options.workDir);
	// B3：任务已跑完（含中断/取消等任何退出路径）→ 清除 resume 快照，避免残留误导后续续跑
	if (options.workDir && options.resumeId) {
		clearResumeState(options.workDir, options.resumeId);
	}

	// Telemetry: end turn spans and trace
	if (currentTurnSpanId) options.tracer?.endSpan(currentTurnSpanId, "ok");
	options.tracer?.endTrace({
		turnCount: finalState.turnCount,
		toolCallCount,
		stopReason: finalState.stopReason,
		contextUsage: stateManager.getContextUsage(),
	});

	// Session end hook
	options.onHook?.("SessionEnd", {
		timestamp: Date.now(),
		duration,
		turnCount: finalState.turnCount,
		stopReason: finalState.stopReason,
		errorCount: finalState.errorHistory.length,
	});

	return {
		finalAnswer: finalAnswer || "模型未返回可显示的输出",
		turnCount: finalState.turnCount,
		stopReason: finalState.stopReason || StopReason.SUCCESS,
		duration,
		toolCallCount,
		errorCount: finalState.errorHistory.length,
		contextUsage: stateManager.getContextUsage(),
	};
}
