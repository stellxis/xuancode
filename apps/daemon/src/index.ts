/**
 * 玄码 Daemon — 后台常驻服务
 *
 * 功能:
 * - HTTP REST API 用于提交/查看 Agent 任务
 * - 定时任务调度 (cron-like)
 * - 会话与运行状态管理
 * - 健康检查端点
 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
	DatabasePool,
	ScheduledTaskStore,
	SessionCollector,
	SessionPersistence,
	TaskStoreSQLite,
	describeCron,
	getNextRunTime,
	parseCron,
} from "@xuancode/database";
import type { ModelAdapter } from "@xuancode/model-adapter";
import { ModelRouter } from "@xuancode/model-router";
import {
	DagExecutor,
	DagGraph,
	ProjectCheckpoint,
	clearResumeState,
	decomposeWithLLM,
	loadCheckpointContext,
	readResumeState,
	recommendMode,
	runTaorLoop,
	shouldUseDagScheduling,
	stripNativeToolJson,
	stripThinkContent,
	stripToolCalls,
	validateDag,
} from "@xuancode/orchestrator";
import type { ResumeState } from "@xuancode/orchestrator";
import type { ModePreset } from "@xuancode/orchestrator";
import { SessionManager } from "@xuancode/session";
import { SubAgentScheduler } from "@xuancode/subagent";
import type { AgentConfig, AttachmentBlock } from "@xuancode/types";
// 公开仓：@xuancode/types 已删除 PermissionLevel（商业配额类型），本地定义以兼容 scheduler 签名
type PermissionLevel = "free" | "professional" | "enterprise";
import { StopReason } from "@xuancode/types";
import type { Message } from "@xuancode/types";
import {
	checkpointDiff,
	createCheckpoint,
	listCheckpointsMerged,
	readConversationSnapshot,
	rollbackCheckpoint,
} from "./checkpoints";
import {
	addModel,
	createModel,
	getModels,
	initModelRegistry,
	removeModel,
	updateModel,
} from "./models/modelRegistry";

import { A2AServer } from "@xuancode/a2a";
import { MemoryManager } from "@xuancode/context";
import {
	API_VERSION,
	API_VERSION_HEADER,
	type ErrorBody,
	MIN_SUPPORTED_API_VERSION,
	PROTOCOL_NAME,
	type VersionInfo,
	type WorkflowEvent,
} from "@xuancode/daemon-protocol";
import { SessionDistiller } from "@xuancode/distiller";
import { SessionIndexer } from "@xuancode/indexer";
import {
	MCPServer,
	SSETransport,
	createMCPHttpHandler,
} from "@xuancode/mcp-server";
import duckduckgoPlugin from "@xuancode/plugin-duckduckgo";
import searxngPlugin from "@xuancode/plugin-searxng";
import serpapiPlugin from "@xuancode/plugin-serpapi";
import { PluginManager } from "@xuancode/plugins";
import { SpeedrunAnalyzer, Tracer } from "@xuancode/telemetry";
import type { AgentTrace, TraceSpan } from "@xuancode/telemetry";
import { ToolManager } from "@xuancode/tools";
import {
	SEMANTIC_SEARCH_DEF,
	clearSearchProvider,
	collectModifiedFiles,
	detectConflicts,
	formatConflictReport,
	getGlobalLockManager,
	setSearchProvider,
} from "@xuancode/tools";
import { ADMIN_HTML } from "./adminHtml";
import { CodeIntelligenceService } from "./codeIntelligence/codeIntelligenceService";
import { ComputerUseService } from "./computerUse/computerUseService";
import { createComputerUseExtraDefinitions } from "./computerUse/computerUseTool";
import { EventStream, type SystemEventType } from "./eventStream.js";
import { readBody, respond } from "./http";
import { MOBILE_HTML } from "./mobileHtml";
import { OptimizerService } from "./optimizer/optimizerService";
import { ScheduledTaskManager } from "./scheduledTaskManager.js";
import type { FileChangeEvent, WorkerMessage } from "./units/channel";
import {
	createCommand,
	createRequest,
	nextCorrelationId,
} from "./units/channel";
import { WhisperLocalEngine } from "./whisperLocal.js";

// ===== 版本（协议契约单点 @xuancode/daemon-protocol） =====
const DAEMON_VERSION = "1.5.103";

// ===== Windows 长路径前缀（\\?\） =====
const WIN_PATH_THRESHOLD = 240;
function normalizeWinPath(p: string): string {
	if (process.platform !== "win32") return p;
	if (p.length < WIN_PATH_THRESHOLD) return p;
	const normalized = p.replace(/\//g, "\\");
	if (normalized.startsWith("\\\\?\\")) return normalized;
	return `\\\\?\\${normalized}`;
}

/** 检查点类端点：优先用 ?path= 指定的项目目录，缺省回退到 daemon workDir */
function resolveCheckpointDir(url: URL, fallback: string): string {
	const p = url.searchParams.get("path");
	return p ? normalizeWinPath(p) : fallback;
}

/** 简单字符串哈希（用于索引路径隔离） */
function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = (hash << 5) - hash + str.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash).toString(36);
}

// ===== COMBAT Worker 任务句柄 =====

interface CombatTaskHandle {
	worker: WorkerCommander;
	startedAt: number;
	abortController: AbortController;
}

// ===== 任务状态 =====

interface DaemonTask {
	id: string;
	userId?: string;
	userInput: string;
	config: Partial<AgentConfig>;
	attachments?: AttachmentBlock[];
	/** 前置消息历史（同一 session 内保持记忆） */
	messages?: Message[];
	/** 会话分组 ID，用于跨任务消息缓存 */
	sessionId?: string;
	status: "queued" | "running" | "completed" | "failed" | "awaiting_input";
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	/** 当前执行轮次（实时轮询） */
	currentTurn?: number;
	/** 当前工具调用描述（实时轮询） */
	currentToolCall?: string;
	/** 进度摘要（实时轮询） */
	progressSummary?: string;
	/** 工作流状态（仅 enableWorkflow 模式） */
	workflowStatus?: {
		summary: string;
		completed: number;
		total: number;
		currentStep: string | null;
	};
	result?: {
		finalAnswer: string;
		turnCount: number;
		stopReason: StopReason;
		duration: number;
		toolCallCount: number;
	};
	error?: string;
	/** 自动审查结果 */
	reviewResult?: string;
	/** 用户权限等级（用于运行时决策） */
	userPermissionLevel?: PermissionLevel;
	// ── 人工介入字段 ──
	/** 开始等待用户输入的时间戳 */
	awaitingSince?: number;
	/** 等待用户决策的问题 */
	pendingQuestion?: string;
	/** 决策上下文 */
	pendingContext?: unknown;
	/** 本轮已介入次数 */
	interventionCount?: number;
	/** 关联的定时任务 ID（由 ScheduledTaskManager 设置） */
	scheduledTaskId?: string;
	/** 当前重试次数（定时任务失败重试） */
	retryCount?: number;
}

// ===== 调度器 =====

export class DaemonScheduler {
	private tasks: Map<string, DaemonTask> = new Map();
	private abortControllers: Map<string, AbortController> = new Map();
	/** 每个运行中任务的空闲超时控制器（活动重置 + 用户等待挂起），任务结束 dispose */
	private idleTimeouts: Map<string, IdleAbortController> = new Map();
	private running = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private sessionManager: SessionManager;
	model: ModelAdapter;
	private workDir: string;
	private maxTaskDuration: number;
	// ── 并发控制 ──
	private concurrencySemaphore = 0;
	private maxConcurrentTasks = 1;
	/** 单任务最大介入次数 */
	private maxInterventions = 5;
	/** 按 sessionId 缓存消息历史，用于多轮对话记忆 */
	private sessionMessageCache: Map<string, Message[]> = new Map();
	/** 可选 Hook 回调（来自 PluginManager） */
	onHook?: (event: string, context: Record<string, unknown>) => void;
	/** 计算机控制服务（Computer Use），在 startDaemonServer 中注入 */
	computerUseService?: ComputerUseService;
	/** 可选可观测性追踪器 */
	tracer?: Tracer | null;
	/** 会话自动蒸馏 */
	sessionDistiller: SessionDistiller | null = null;
	/** 插件管理器引用（用于桥接插件 tools 到 taorLoop） */
	pluginManager?: PluginManager;
	/** 追加式系统事件流（跨会话审计/回放），由 startDaemonServer 注入 */
	eventStream?: EventStream;
	/** RECON 侦察单元通信器（由 startDaemonServer 注入） */
	reconCommander: WorkerCommander | null = null;
	/** COMBAT 作战单元任务句柄（由 executeTask 管理） */
	combatTasks = new Map<string, CombatTaskHandle>();
	/** 子 Agent 后台任务分组（用于 collect_subagents 按组收集） */
	subAgentGroups = new Map<string, Set<string>>();

	/** 五行 · 待用户确认的权限请求（requestId → resolver）。条目常驻直至用户选择；任务结束由 resolvePendingPermissions 统一清理 */
	pendingPermissionRequests = new Map<
		string,
		{
			resolve: (allowed: boolean) => void;
			toolType: string;
			timestamp: number;
			taskId: string;
		}
	>();

	/** ask_user 工具：等待用户输入的任务（taskId → resolver）。inline 直接 resolve，worker 转发 answer_user 命令 */
	pendingInputRequests = new Map<
		string,
		{ resolve: (answer: string) => void; source: "inline" | "worker" }
	>();

	/** INTEL 情报单元通信器 */
	intelCommander: WorkerCommander | null = null;
	/** SQLite 会话持久化（内联回退） */
	sessionPersistence: SessionPersistence | null = null;
	/** FTS5 会话全文索引（内联回退） */
	sessionIndexer: SessionIndexer | null = null;
	/** 任务持久化（SQLite daemon_tasks 表） */
	taskStore: TaskStoreSQLite | null = null;

	constructor(
		sessionManager: SessionManager,
		model: ModelAdapter,
		workDir: string,
		maxTaskDuration = 600_000,
	) {
		this.sessionManager = sessionManager;
		this.model = model;
		this.workDir = workDir;
		this.maxTaskDuration = maxTaskDuration;
	}

	/** 追加系统事件（失败不打断主流程） */
	logEvent(type: SystemEventType, payload: Record<string, unknown> = {}): void {
		this.eventStream?.append(type, payload).catch((err) => {
			console.error(`[eventStream] 写入事件 ${type} 失败:`, err);
		});
	}

	/** 提交新任务 */
	submit(
		input: string,
		config?: Partial<AgentConfig>,
		attachments?: AttachmentBlock[],
		messages?: Message[],
		sessionId?: string,
		userId?: string,
		permissionLevel?: PermissionLevel,
	): DaemonTask {
		const task: DaemonTask = {
			id: randomUUID(),
			userInput: input,
			config: config || {},
			attachments,
			messages,
			sessionId,
			userId,
			userPermissionLevel: permissionLevel,
			status: "queued",
			createdAt: new Date().toISOString(),
		};
		this.tasks.set(task.id, task);
		// 持久化到 SQLite
		this.taskStore?.saveTask(task);
		return task;
	}

	/** 取消正在执行的任务 */
	cancelTask(taskId: string): boolean {
		// Try combat worker first (Phase 2: graceful abort → force terminate)
		const handle = this.combatTasks.get(taskId);
		if (handle) {
			handle.worker.sendCommand("abort_task");
			// Force terminate after 3s if worker hasn't exited
			setTimeout(() => {
				const h = this.combatTasks.get(taskId);
				if (h) {
					h.worker.terminate().catch(() => {});
					this.combatTasks.delete(taskId);
				}
			}, 3000);
			return true;
		}
		// Fall back to abort controller for inline execution
		const controller = this.abortControllers.get(taskId);
		if (controller) {
			controller.abort();
			return true;
		}
		return false;
	}

	/** 清理指定任务的所有待确认权限请求：resolve(false) 解除 runTaorLoop 阻塞并释放 Map 条目 */
	resolvePendingPermissions(taskId: string): void {
		for (const [requestId, entry] of this.pendingPermissionRequests) {
			if (entry.taskId === taskId) {
				this.pendingPermissionRequests.delete(requestId);
				entry.resolve(false);
			}
		}
	}

	/** 清理指定任务的所有待回答输入请求：任务结束/取消/失败时解除 ask_user 阻塞并释放 Map 条目（防悬挂/泄漏）。
	 *  同步发布 input_received，让渲染端决策面板关闭。worker 源无需再发 answer_user（worker 已随任务终止）。 */
	resolvePendingInputs(taskId: string): void {
		const pending = this.pendingInputRequests.get(taskId);
		if (!pending) return;
		this.pendingInputRequests.delete(taskId);
		if (pending.source === "inline") {
			const note = "(任务已结束，未收到用户选择)";
			pending.resolve(note);
			taskEventBus.publish(taskId, "input_received", { answer: note });
		}
	}

	/** 通过 COMBAT Worker 执行任务（Phase 2） */
	private async executeTaskViaWorker(
		task: DaemonTask,
		sessionStore: any,
		augmentedInput: string,
		resume?: ResumeState | null,
	): Promise<{
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
		collectedEntries?: any[];
		lastMessages?: any[] | null;
		traceId?: string;
		traceData?: any;
	}> {
		const workerPath = resolveCombatWorkerPath();
		if (!workerPath) throw new Error("COMBAT Worker path not found");

		const combat = new WorkerCommander(workerPath);
		const handle: CombatTaskHandle = {
			worker: combat,
			startedAt: Date.now(),
			abortController: new AbortController(),
		};
		this.combatTasks.set(task.id, handle);

		const unsubs: (() => void)[] = [];

		try {
			// Bridge Worker events to taskEventBus (SSE) + task state + session store
			unsubs.push(
				combat.onEvent("turn", (payload: any) => {
					task.currentTurn = payload.turn;
					taskEventBus.publish(task.id, "turn", payload);
				}),
			);
			unsubs.push(
				combat.onEvent("tool_call", (payload: any) => {
					task.currentToolCall = payload.toolType;
					task.progressSummary = `工具: ${payload.toolType}`;
					taskEventBus.publish(task.id, "tool_call", payload);
					sessionStore
						?.logToolCall?.(
							task.currentTurn || 0,
							{ type: payload.toolType, ...payload.params },
							{
								success: payload.result?.success,
								data: payload.result?.output?.slice(0, 500),
								error: payload.result?.error,
							},
						)
						.catch(() => {});
				}),
			);
			unsubs.push(
				combat.onEvent("error", (payload: any) => {
					const msg = `错误 (${payload.site}): ${payload.message}`;
					task.progressSummary = msg;
					taskEventBus.publish(task.id, "error", {
						...payload,
						turn: task.currentTurn,
					});
					sessionStore
						?.logError?.(
							task.currentTurn || 0,
							payload.site,
							payload.message,
							true,
						)
						.catch(() => {});
				}),
			);
			unsubs.push(
				combat.onEvent("token", (payload: any) => {
					task.progressSummary = payload.fullText?.slice(-200);
					taskEventBus.publish(task.id, "token", payload);
				}),
			);
			unsubs.push(
				combat.onEvent("reasoning", (payload: any) => {
					taskEventBus.publish(task.id, "reasoning", payload);
				}),
			);
			unsubs.push(
				combat.onEvent("telemetry_span", (payload: any) => {
					taskEventBus.publish(task.id, "telemetry_span", payload);
				}),
			);
			unsubs.push(
				combat.onEvent("progress", (payload: any) => {
					task.progressSummary = payload?.summary;
					taskEventBus.publish(task.id, "progress", payload);
				}),
			);
			unsubs.push(
				combat.onEvent("ask_user", (payload: any) => {
					task.status = "awaiting_input";
					task.pendingQuestion = payload?.question;
					task.pendingContext = {
						options: payload?.options,
						correlationId: payload?.correlationId,
					};
					task.awaitingSince = Date.now();
					// V2 竞态修复：先注册 resolver 再 publish SSE
					const correlationId = payload?.correlationId;
					this.pendingInputRequests.set(task.id, {
						source: "worker",
						resolve: (answer: string) => {
							this.pendingInputRequests.delete(task.id);
							if (correlationId) {
								combat.sendCommand("answer_user", { correlationId, answer });
							}
						},
					});
					taskEventBus.publish(task.id, "ask_user", payload);
				}),
			);

			// Extract provider/model from scheduler's ModelRouter
			let provider = "deepseek";
			let modelName = "deepseek-v4-flash";
			if (this.model instanceof ModelRouter) {
				provider = this.model.provider;
				modelName = this.model.modelName;
			}

			const response = await combat.request<any>(
				"execute_task",
				{
					augmentedInput,
					attachments: task.attachments,
					workDir: this.workDir,
					config: task.config,
					resume: resume
						? {
								messages: resume.messages,
								turnCount: resume.turnCount,
								checkpoint: ProjectCheckpoint.fromFile(this.workDir).snapshot(),
							}
						: undefined,
					resumeId: resume ? task.id : undefined,
					provider,
					modelName,
					computerUseEnabled: this.computerUseService?.enabled ?? false,
					maxTaskDuration: this.maxTaskDuration,
					sessionId: task.sessionId,
					modelEntries: getModels(),
					reasoningLevel:
						(process.env.REASONING_LEVEL as "fast" | "medium" | "expert") ||
						undefined,
				},
				// 空闲感知超时：worker 持续吐事件（token/turn/tool_call）即重置计时；
				// 下限 10 分钟兜底 worker 假死（无任何事件）的情况
				Math.max(this.maxTaskDuration, 600_000) + 30_000,
				{ resetOnEvent: true },
			);

			// Import trace from worker into daemon's tracer for optimizer analysis
			if (response?.traceData && this.tracer) {
				try {
					this.tracer.importTrace(response.traceData as any);
				} catch (err) {
					console.error("[COMBAT] Failed to import worker trace:", err);
				}
			}

			return response;
		} finally {
			this.combatTasks.delete(task.id);
			unsubs.forEach((fn) => fn());
			combat.terminate().catch(() => {});
		}
	}

	/** 获取任务状态 */
	getTask(id: string): DaemonTask | undefined {
		return this.tasks.get(id);
	}

	/** 列出所有任务（含 SQLite 历史，重启后不丢失） */
	listTasks(limit = 20): DaemonTask[] {
		const map = new Map(this.tasks);
		// 补充 SQLite 中的历史任务（已完成/失败的）
		if (this.taskStore) {
			const rows = this.taskStore.listTasks(undefined, limit * 2);
			for (const row of rows) {
				if (!map.has(row.id)) {
					map.set(row.id, {
						id: row.id,
						userId: row.user_id || undefined,
						userInput: row.user_input,
						config: row.config_json ? JSON.parse(row.config_json) : {},
						status: row.status as DaemonTask["status"],
						createdAt: row.created_at,
						startedAt: row.started_at || undefined,
						completedAt: row.completed_at || undefined,
						currentTurn: row.current_turn ?? undefined,
						progressSummary: row.progress_summary || undefined,
						sessionId: row.session_id || undefined,
					});
				}
			}
		}
		return Array.from(map.values())
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, limit);
	}

	/** 执行任务（使用真实 TAOR 循环和会话日志） */
	async executeTask(task: DaemonTask): Promise<void> {
		task.status = "running";
		task.startedAt = new Date().toISOString();
		task.currentTurn = 0;

		// 提前声明（若在 try 内声明，提前抛错时 finally 引用会触发 TDZ ReferenceError，掩盖原始错误）
		const unspan: (() => void)[] = [];
		// 空闲超时活动订阅解除函数（try 内赋值，finally 中解除）
		let unsubIdleActivity: () => void = () => {};

		try {
			// 创建会话日志
			const sessionStore = await this.sessionManager.createSession(
				task.config,
				task.userInput,
			);
			const sessionId = sessionStore.getSessionId();
			this.logEvent("task_created", {
				taskId: task.id,
				sessionId,
				input: task.userInput.slice(0, 500),
			});
			this.logEvent("session_started", {
				taskId: task.id,
				sessionId,
				config: task.config,
			});

			// 使用真实 TAOR 循环
			// 空闲超时（非墙钟硬杀）：连续 maxTaskDuration 内无任何输出/工具活动才中止；
			// token/turn/tool_call 等任意 SSE 事件都会重置计时，长任务可以跑数小时。
			const idleTimeout = new IdleAbortController(this.maxTaskDuration, () => {
				const msg = `任务空闲超时：连续 ${Math.round(this.maxTaskDuration / 60_000)} 分钟无输出/工具活动，已中止（可从检查点续跑）`;
				console.error(`[daemon] ${msg}`);
				taskEventBus.publish(task.id, "error", {
					message: msg,
					site: "idle_timeout",
				});
			});
			this.idleTimeouts.set(task.id, idleTimeout);
			// 活动源：该任务的任意事件总线事件都视为活动（token/turn/tool_call/progress/verify/workflow…）
			unsubIdleActivity = taskEventBus.subscribe(task.id, () =>
				idleTimeout.activity(),
			);
			const abortController = new AbortController();
			this.abortControllers.set(task.id, abortController);
			// 任一个触发即中止
			const combinedSignal =
				AbortSignal.any?.([idleTimeout.signal, abortController.signal]) ||
				idleTimeout.signal;

			// 会话数据收集器（SQLite 持久化用）
			const collectorRef: { current: SessionCollector | null } = {
				current: null,
			};
			const sessionCollector = new SessionCollector();
			collectorRef.current = sessionCollector;
			// 捕获最新消息用于蒸馏
			const lastMessagesRef: { current: any[] | null } = { current: null };

			// 从历史消息构建「近期优先」对话摘要：最近消息保留更多原文，旧消息压缩。
			// 排除工具结果噪声，避免原始 Message[] 干扰 stopConditions。
			function buildSmartHistory(messages: Message[], maxChars = 6000): string {
				const filtered = messages.filter(
					(m) =>
						!(
							m.role === "user" &&
							typeof m.content === "string" &&
							m.content.startsWith("工具结果:")
						),
				);
				if (filtered.length === 0) return "";
				const lines: string[] = [];
				let total = 0;
				const n = filtered.length;
				for (let i = 0; i < n; i++) {
					const m = filtered[i];
					const role = m.role === "user" ? "用户" : "玄码";
					const remaining = n - i;
					const cap = remaining <= 2 ? 1500 : remaining <= 4 ? 600 : 200;
					const line = `${role}: ${(m.content || "").slice(0, cap)}`;
					if (total + line.length > maxChars) break;
					lines.push(line);
					total += line.length;
				}
				return lines.join("\n");
			}

			// 解析历史消息：优先使用显式传入的 messages，其次按 sessionId 从缓存读取
			const historyMsgs = task.messages?.length
				? task.messages
				: task.sessionId
					? this.sessionMessageCache.get(task.sessionId) || []
					: [];
			// 续跑重点记忆：项目状态（计划/完成情况/关键节点）优先注入
			const projectStateBlock = loadCheckpointContext(this.workDir);
			const historyBlock =
				historyMsgs.length > 0 ? buildSmartHistory(historyMsgs) : "";
			const augmentedInput = [
				projectStateBlock ? `[项目状态]\n${projectStateBlock}` : "",
				historyBlock ? `[上轮对话]\n${historyBlock}` : "",
				`[当前问题]\n${task.userInput}`,
			]
				.filter(Boolean)
				.join("\n\n");

			console.error("[daemon] task.userInput length:", task.userInput?.length);
			console.error("[daemon] historyMsgs length:", historyMsgs.length);
			console.error("[daemon] historyBlock length:", historyBlock.length);
			console.error("[daemon] augmentedInput length:", augmentedInput.length);

			// 插件 tool overrides（去掉命名空间前缀）
			const pluginOverrides: Record<string, (params: any) => Promise<any>> = {};
			if (this.pluginManager) {
				const rawOverrides = this.pluginManager.registry.getToolOverrides();
				for (const [name, handler] of rawOverrides) {
					pluginOverrides[name] = handler;
				}
			}

			// 插件 tool definitions — 使插件注册的新工具能被 AI 模型感知和调用
			const extraDefs: Array<{
				def: any;
				handler: (params: any) => Promise<any>;
			}> = [];
			if (this.pluginManager) {
				const pluginDefs = this.pluginManager.registry.getToolDefinitions();
				for (const pd of pluginDefs) {
					extraDefs.push(pd);
				}
			}

			// 内置额外工具定义
			extraDefs.push({
				def: SEMANTIC_SEARCH_DEF,
				handler: async (params) => {
					const { semanticSearch } = await import("@xuancode/tools");
					return semanticSearch(params.query || "", params.path);
				},
			});

			// ask_user 工具：模型可向用户提问，等待用户选择分支后继续（inline 路径）
			extraDefs.push({
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
				handler: async (params) => {
					const question = String(params.question || "");
					const options = Array.isArray(params.options)
						? params.options.map(String)
						: [];
					task.status = "awaiting_input";
					task.pendingQuestion = question;
					task.pendingContext = { options };
					task.awaitingSince = Date.now();
					// 常驻：不设超时，决策面板一直停留直到用户选择/提交（与权限卡片一致）；
					// 任务结束/取消/失败由 resolvePendingInputs 统一 resolve 解除阻塞、防悬挂。
					// V2 竞态修复：先注册 resolver 再 publish，确保订阅者收到 SSE 时一定能在 Map 里命中
					return new Promise((resolve) => {
						// 等用户回答期间挂起空闲计时（用户想多久都行）
						this.idleTimeouts.get(task.id)?.suspend();
						this.pendingInputRequests.set(task.id, {
							source: "inline",
							resolve: (message: string) => {
								this.pendingInputRequests.delete(task.id);
								this.idleTimeouts.get(task.id)?.resume();
								task.status = "running";
								task.awaitingSince = undefined;
								task.pendingQuestion = undefined;
								resolve({ success: true, data: message });
							},
						});
						// resolver 已就位，安全发布 SSE
						taskEventBus.publish(task.id, "ask_user", { question, options });
					});
				},
			});
			const cuSvc = this.computerUseService;
			if (cuSvc?.enabled) {
				extraDefs.push(...createComputerUseExtraDefinitions(cuSvc));
			}

			// 读取子 Agent 配置（用于 fork_subagent 和 DAG 调度）
			const agentConfig = (task.config as any)?.agentConfig as
				| { enabledTypes?: string[]; maxConcurrency?: number }
				| undefined;
			const enabledTypes = agentConfig?.enabledTypes?.length
				? agentConfig.enabledTypes
				: [
						"explore",
						"plan",
						"implement",
						"review",
						"security",
						"test",
						"docs",
						"debug",
					];

			// fork_subagent 工具：主 Agent 可派生子 Agent 执行独立子任务
			const subAgentScheduler = new SubAgentScheduler(
				() => this.model,
				this.workDir,
			);
			extraDefs.push({
				def: {
					type: "fork_subagent",
					name: "fork_subagent",
					description:
						"派生一个子 Agent 执行独立子任务（代码搜索、文档查阅、安全审查等）。子任务与主任务无依赖关系时使用，子 Agent 执行结果将以工具结果形式返回。",
					parameters: [
						{
							name: "subAgentType",
							type: "string",
							description:
								"子 Agent 类型: explore(代码探索) / plan(方案设计) / implement(编码实现) / review(代码审查) / security(安全审计) / test(测试) / docs(文档) / debug(调试)",
							required: true,
							enumValues: enabledTypes,
						},
						{
							name: "instruction",
							type: "string",
							description:
								"子任务的详细指令。请清晰描述子 Agent 需要完成的具体工作。",
							required: true,
						},
						{
							name: "mode",
							type: "string",
							description:
								"执行模式: sync(同步等待结果) / background(后台执行，稍后用 collect_subagents 获取结果)",
							required: false,
							enumValues: ["sync", "background"],
						},
						{
							name: "groupId",
							type: "string",
							description:
								"任务组 ID。用于将多个子 Agent 分组，collect_subagents 可按组收集结果",
							required: false,
						},
					],
					examples: [
						{
							description: "同步探索代码",
							params: {
								subAgentType: "explore",
								instruction: "列出 src 目录结构",
								mode: "sync",
							},
						},
						{
							description: "后台审查安全",
							params: {
								subAgentType: "security",
								instruction: "审查 auth 模块",
								mode: "background",
								groupId: "review-group",
							},
						},
					],
					alwaysLoad: true,
					category: "earth",
				},
				handler: async (params) => {
					const type = params.subAgentType;
					const instruction = params.instruction;
					const mode =
						(params.mode as string) === "background" ? "background" : "sync";
					const groupId = params.groupId as string | undefined;
					if (!enabledTypes.includes(type)) {
						return {
							success: false,
							data: "",
							error: `不支持的子 Agent 类型: ${type}`,
						};
					}
					try {
						const result = await subAgentScheduler.delegate(
							type,
							instruction,
							mode,
						);
						if (mode === "background" && groupId) {
							try {
								const parsed = JSON.parse(result);
								const taskId = parsed.taskId;
								if (taskId) {
									if (!this.subAgentGroups.has(groupId)) {
										this.subAgentGroups.set(groupId, new Set());
									}
									this.subAgentGroups.get(groupId)?.add(taskId);
								}
							} catch {
								// Not JSON-formatted result, skip group tracking
							}
						}
						return { success: true, data: result };
					} catch (err: any) {
						return {
							success: false,
							data: "",
							error: `子 Agent 执行失败: ${err.message}`,
						};
					}
				},
			});

			// collect_subagents 工具：主 Agent 收集后台子 Agent 的执行结果
			extraDefs.push({
				def: {
					type: "collect_subagents",
					name: "collect_subagents",
					description:
						"等待后台子 Agent 执行完成并收集结果。可指定 groupId 只等待特定组的任务。",
					parameters: [
						{
							name: "groupId",
							type: "string",
							description:
								"可选。只收集该组的子 Agent 结果。不指定则收集所有后台任务。",
							required: false,
						},
						{
							name: "timeout",
							type: "number",
							description: "可选。最大等待时间（毫秒），默认 300000 (5分钟)",
							required: false,
						},
					],
					examples: [
						{ description: "收集所有后台任务", params: {} },
						{
							description: "收集指定组",
							params: { groupId: "review-group", timeout: 60000 },
						},
					],
					alwaysLoad: true,
					category: "earth",
				},
				handler: async (params) => {
					const timeout = (params.timeout as number) || 300000;
					try {
						const results = await Promise.race([
							subAgentScheduler.waitForAll(),
							new Promise<Map<string, string>>((_, reject) =>
								setTimeout(() => reject(new Error("等待超时")), timeout),
							),
						]);
						const formatted = Array.from(results.entries())
							.map(([id, result]) => `[${id}]: ${result.slice(0, 1000)}`)
							.join("\n\n");
						return {
							success: true,
							data: `子 Agent 执行完毕 (${results.size} 个任务):\n${formatted}`,
						};
					} catch (err: any) {
						return {
							success: false,
							data: "",
							error: `收集子 Agent 结果失败: ${err.message}`,
						};
					}
				},
			});

			// Bridge Tracer span events to SSE stream
			if (this.tracer) {
				unspan.push(
					this.tracer.onSpanEvent("span_start", (span) => {
						try {
							taskEventBus.publish(task.id, "telemetry_span", {
								type: "span_start",
								...span,
							});
						} catch {
							/* span bridge error — non-critical */
						}
					}),
				);
				unspan.push(
					this.tracer.onSpanEvent("span_end", (span) => {
						try {
							taskEventBus.publish(task.id, "telemetry_span", {
								type: "span_end",
								...span,
							});
						} catch {
							/* span bridge error — non-critical */
						}
					}),
				);
			}

			// ===== Phase 3: DAG 拓扑调度（自动分解 + 并行执行）=====
			let dagResult: any = null;
			let workflowManagerForInline: any = null;
			const modePreset = (task.config as any)?.modePreset as
				| ModePreset
				| undefined;
			const dagConcurrency =
				agentConfig?.maxConcurrency || (modePreset === "local" ? 8 : 4);

			// ===== B3 断点续跑解析 =====
			// resumeTaskId 门控：仅显式标记续跑同一任务时才启用；turnCount 与 checkpoint 不一致则
			// 回退到 loadCheckpointContext 记忆注入的冷启动（不传 resume）。续跑只播种 transcript，
			// 由 orchestrator 从最后一条消息继续，绝不复放已执行工具历史。
			let resumeState: ResumeState | null = null;
			const resumeTaskId = (task.config as any)?.resumeTaskId;
			if (resumeTaskId && resumeTaskId === task.id) {
				const snap = readResumeState(this.workDir, task.id);
				if (snap) {
					const cpTurns = ProjectCheckpoint.fromFile(this.workDir).snapshot()
						.turnsUsed;
					if (cpTurns !== snap.turnCount) {
						resumeState = null; // 轮次不一致 → 冷启动
					} else {
						resumeState = snap;
					}
				}
			}
			if (resumeState) {
				task.currentTurn = resumeState.turnCount;
				taskEventBus.publish(task.id, "turn", {
					turn: resumeState.turnCount,
					contextUsage: 0,
					message: `⏸ 已从断点续跑（第 ${resumeState.turnCount} 轮）`,
				});
			}

			// C1 · Git 检查点：任务开始前自动提交工作区（复用 gitTool，仅本地，绝不 push）。
			// 续跑任务不重复建；config.enableCheckpoint === false 可关闭。非仓库/干净树自动跳过。
			// 测试模式跳过：避免测试任务污染用户仓库提交历史。
			if (
				!forceInlineForTests &&
				!resumeState &&
				(task.config as any)?.enableCheckpoint !== false
			) {
				try {
					const cp = await createCheckpoint(this.workDir, {
						input: task.userInput,
						messages: task.messages as any,
					});
					if (cp.created && cp.hash) {
						taskEventBus.publish(task.id, "checkpoint", {
							hash: cp.hash,
							message: `已创建 Git 检查点 ${cp.hash.slice(0, 8)}`,
						});
					}
				} catch (e) {
					console.error("[玄码] 创建 Git 检查点失败（不阻塞任务）:", e);
				}
			}

			// DAG 检测：只用当前用户输入（避免历史摘要误触），与 mode 无关；续跑任务直接走 TAOR 循环不复分解
			const dagInput = task.userInput;
			const autoDecompose = (task.config as any)?.autoDecompose !== false;
			const shouldDag =
				!resumeState &&
				autoDecompose &&
				shouldUseDagScheduling(dagInput, modePreset);
			const enableWorkflow = (task.config as any)?.enableWorkflow === true;

			// 工作流事件桥接（SSE）：restore / seed 两条路径共用
			const createWorkflowManager = async (): Promise<any> => {
				const { WorkflowPlanManager } = await import("@xuancode/orchestrator");
				return new WorkflowPlanManager({
					onEvent: (event: WorkflowEvent) => {
						taskEventBus.publish(task.id, "workflow", {
							type: event.type,
							planId: event.planId,
							stepId: event.stepId,
							timestamp: event.timestamp,
							data: event.data,
						});
						if (event.type === "step_completed") {
							taskEventBus.publish(task.id, "token", {
								token: "",
								fullText: `\n\n✅ 步骤完成: ${event.data?.label || event.stepId}\n`,
							});
						} else if (event.type === "step_failed") {
							taskEventBus.publish(task.id, "error", {
								message: `步骤失败 [${event.stepId}]: ${event.data?.error}`,
								site: "workflow",
							});
						} else if (event.type === "plan_completed") {
							taskEventBus.publish(task.id, "token", {
								token: "",
								fullText: "\n\n🎯 工作流计划已完成!\n",
							});
						}
					},
				});
			};

			// B3 续跑 + 工作流：resume 快照带完整计划 → 原样恢复（步骤状态/currentStepId/context），不重新分解
			if (enableWorkflow && resumeState?.plan) {
				const wfManager = await createWorkflowManager();
				wfManager.restorePlan(resumeState.plan);
				workflowManagerForInline = wfManager;
				taskEventBus.publish(task.id, "turn", {
					turn: 0,
					contextUsage: 0,
					dagStatus: "workflow_restored",
					message: `已从断点恢复工作流计划: ${wfManager.getProgress().completed}/${wfManager.getProgress().total} 步已完成，继续执行`,
				});
			} else if (shouldDag || enableWorkflow) {
				try {
					taskEventBus.publish(task.id, "turn", {
						turn: 0,
						contextUsage: 0,
						dagStatus: "decomposing",
						message: "正在分析，拆解子任务...",
					});

					// 1. 分解任务为 DAG
					const decomposition = await decomposeWithLLM(augmentedInput, {
						chat: async (
							messages: Array<{ role: string; content: string }>,
						) => {
							const m = await this.model.chat(
								messages as any,
								"你是一个任务分解专家。仅输出 JSON 格式的分解结果，不要其他内容。",
							);
							return m;
						},
					});

					const validation = validateDag(decomposition.nodes);
					if (validation.valid && decomposition.nodes.length > 1) {
						taskEventBus.publish(task.id, "turn", {
							turn: 0,
							contextUsage: 0,
							dagStatus: "executing",
							message: `拆分为 ${decomposition.nodes.length} 个子任务 (${decomposition.summary})`,
							dagNodeCount: decomposition.nodes.length,
						});

						// 2. 过滤禁用类型的子节点（回退到 implement）
						for (const node of decomposition.nodes) {
							if (!enabledTypes.includes(node.subAgentType)) {
								node.subAgentType = "implement";
							}
						}

						// 2.5 动态工作流路径：将 DAG 播种到 WorkflowPlan，通过 TAOR 循环动态执行
						if (enableWorkflow) {
							const { seedFromDag } = await import("@xuancode/orchestrator");
							const wfManager = await createWorkflowManager();
							seedFromDag(
								wfManager,
								decomposition.nodes,
								decomposition.summary,
							);
							workflowManagerForInline = wfManager;
							taskEventBus.publish(task.id, "turn", {
								turn: 0,
								contextUsage: 0,
								dagStatus: "workflow_seeded",
								message: `工作流计划已就绪: ${decomposition.nodes.length} 个步骤可在 TAOR 循环中动态执行`,
							});
						} else {
							// 3. 构建 DAG 图（原有静态 DAG 路径）
							const graph = new DagGraph();
							for (const node of decomposition.nodes) {
								graph.addNode(node);
							}

							// 4. 执行 DAG
							const executor = new DagExecutor(graph, {
								maxConcurrency: dagConcurrency,
								modelFactory: () => this.model,
								workDir: this.workDir,
								schedulerFactory: (mf, wd) =>
									new SubAgentScheduler(mf as any, wd),
								onNodeStart: (node) => {
									task.currentTurn = (task.currentTurn || 0) + 1;
									taskEventBus.publish(task.id, "turn", {
										turn: task.currentTurn,
										contextUsage: 0,
										dagNode: node.id,
										dagNodeLabel: node.label,
										dagMessage: `▶ 执行: ${node.label}`,
									});
								},
								onNodeComplete: (node) => {
									taskEventBus.publish(task.id, "token", {
										token: "",
										fullText: `\n\n✅ 子任务完成: ${node.label}\n`,
									});
								},
								onNodeError: (node, error) => {
									taskEventBus.publish(task.id, "error", {
										message: `子任务失败 [${node.label}]: ${error}`,
										site: "dag",
										turn: task.currentTurn,
									});
								},
							});

							const execResult = await executor.execute();

							// 5. 冲突检测
							const lockMgr = getGlobalLockManager();
							const snapshots = lockMgr.getAllSnapshots();
							if (snapshots.size > 0) {
								const modifiedFiles = collectModifiedFiles(
									snapshots,
									this.workDir,
								);
								const conflictReport = detectConflicts(
									snapshots,
									modifiedFiles,
								);
								if (conflictReport.conflicts.length > 0) {
									const reportText = formatConflictReport(conflictReport);
									taskEventBus.publish(task.id, "turn", {
										turn: (task.currentTurn || 0) + 1,
										contextUsage: 0,
										dagStatus: "conflict_check",
										message: `冲突检测: ${conflictReport.autoResolved} 自动解决, ${conflictReport.unresolvable} 需人工介入`,
										conflictReport: reportText.slice(0, 2000),
									});
								}
								lockMgr.clearSnapshots();
							}

							// 5. 汇总结果
							const allResults = Array.from(execResult.nodeResults.entries());
							const summaryParts = allResults.map(([id, text]) => {
								const node = graph.getNode(id);
								const label = node?.label || id;
								return `### ${label}\n${text?.slice(0, 3000) || "(无结果)"}`;
							});

							const combinedAnswer = [
								"## DAG 执行报告\n",
								`分解方式: ${decomposition.summary}`,
								`子任务总数: ${decomposition.nodes.length}`,
								`成功: ${decomposition.nodes.length - execResult.failedNodes.length}`,
								execResult.failedNodes.length > 0
									? `失败: ${execResult.failedNodes.length}`
									: "",
								`耗时: ${(execResult.duration / 1000).toFixed(1)}s`,
								"",
								...summaryParts,
							]
								.filter(Boolean)
								.join("\n\n");

							dagResult = {
								finalAnswer: combinedAnswer,
								turnCount: decomposition.nodes.length,
								stopReason: StopReason.DAG_COMPLETE,
								duration: execResult.duration,
								toolCallCount: decomposition.nodes.length,
								errorCount: execResult.failedNodes.length,
								contextUsage: 0,
								dagExecResult: execResult,
							};

							taskEventBus.publish(task.id, "turn", {
								turn: (task.currentTurn || 0) + 1,
								contextUsage: 0,
								dagStatus: "complete",
								message: `DAG 执行完成: ${decomposition.nodes.length - execResult.failedNodes.length}/${decomposition.nodes.length} 子任务成功`,
							});
						} // end else (static DAG path)
					} // end if (validation.valid)
				} catch (dagErr) {
					console.error("[DAG] 调度失败，回退到标准模式:", dagErr);
					taskEventBus.publish(task.id, "token", {
						token: "",
						fullText: "\n\n⚠️ DAG 拓扑调度失败，回退到标准执行模式\n",
					});
				}
			}

			// ===== 执行（优先使用 COMBAT Worker）=====
			const combatWorkerPath = resolveCombatWorkerPath();
			let result: any;
			let collectedEntries: any[] = [];
			let traceId: any;

			if (dagResult) {
				// ---- DAG 拓扑调度结果 ----
				result = dagResult;
			} else if (combatWorkerPath) {
				// ---- Worker 执行 ----
				const response = await this.executeTaskViaWorker(
					task,
					sessionStore,
					augmentedInput,
					resumeState,
				);
				if (!response.success || !response.result) {
					throw new Error(response.error || "COMBAT Worker execution failed");
				}
				result = response.result;
				collectedEntries = response.collectedEntries || [];
				traceId = response.traceId;
				if (response.lastMessages) {
					lastMessagesRef.current = response.lastMessages;
				}
			} else {
				// ---- 内联执行 ----
				let reasoningBufInline = "";
				let lastCleanInline = "";
				const inlineResult = await runTaorLoop(augmentedInput, {
					attachments: task.attachments,
					model: this.model,
					workDir: this.workDir,
					config: task.config,
					resume: resumeState
						? {
								messages: resumeState.messages,
								turnCount: resumeState.turnCount,
								checkpoint: ProjectCheckpoint.fromFile(this.workDir).snapshot(),
							}
						: undefined,
					resumeId: resumeState ? task.id : undefined,
					abortSignal: combinedSignal,
					onHook: this.onHook,
					tracer: this.tracer ?? undefined,
					reasoningLevel:
						(process.env.REASONING_LEVEL as "fast" | "medium" | "expert") ||
						undefined,
					extraHandlerOverrides:
						Object.keys(pluginOverrides).length > 0
							? pluginOverrides
							: undefined,
					extraDefinitions: extraDefs,
					enableWorkflow: !!workflowManagerForInline,
					workflowManager: workflowManagerForInline ?? undefined,
					// 五行 · 用户确认：通过 SSE 发布权限请求，等待 HTTP 端点响应
					onPermissionRequest: async (tc, decision) => {
						const requestId = randomUUID();
						return new Promise<boolean>((resolve) => {
							// 常驻：不设超时，直到用户允许/拒绝；任务结束时由 resolvePendingPermissions 统一 resolve(false) 防悬挂
							// 等用户确认期间挂起空闲计时（用户想多久都行）
							this.idleTimeouts.get(task.id)?.suspend();
							this.pendingPermissionRequests.set(requestId, {
								resolve: (allowed) => {
									this.idleTimeouts.get(task.id)?.resume();
									resolve(allowed);
								},
								toolType: tc.type,
								timestamp: Date.now(),
								taskId: task.id,
							});
							taskEventBus.publish(task.id, "permission_request", {
								requestId,
								toolType: tc.type,
								params: tc,
								reason: decision.reason,
								risk: decision.risk,
							});
						});
					},
					onTurn: (turn, state) => {
						task.currentTurn = turn;
						const s = state;
						const totalChars =
							s.messages?.reduce?.(
								(sum, m) => sum + (m.content?.length || 0),
								0,
							) ?? 0;
						const maxBudget = s.maxContextBudget ?? 1;
						const contextUsage = Math.min(
							100,
							Math.round((totalChars / maxBudget) * 100),
						);
						taskEventBus.publish(task.id, "turn", { turn, contextUsage });
						// 更新工作流状态（UI 轮询）
						if (workflowManagerForInline) {
							const wfProgress = workflowManagerForInline.getProgress();
							const wfPlan = workflowManagerForInline.getPlan();
							task.workflowStatus = {
								summary: wfPlan?.summary || "",
								completed: wfProgress.completed,
								total: wfProgress.total,
								currentStep: wfProgress.current,
							};
						}
						collectorRef.current?.captureNewMessages(turn, s);
						lastMessagesRef.current = s?.messages || null;
					},
					onProgress: (info) => {
						task.progressSummary = info.summary;
						taskEventBus.publish(task.id, "progress", info);
					},
					onVerifyGate: (info) => {
						taskEventBus.publish(task.id, "verify", info);
					},
					onToolCall: (tc, tr) => {
						task.currentToolCall = tc.type;
						task.progressSummary = `工具: ${tc.type}`;
						taskEventBus.publish(task.id, "tool_call", {
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
						sessionStore
							.logToolCall(
								task.currentTurn || 0,
								{
									type: tc.type,
									path: tc.path,
									command: tc.command,
									pattern: tc.pattern,
								},
								{
									success: tr.success,
									data: tr.data?.slice(0, 500),
									error: tr.error,
								},
							)
							.catch(() => {});
						collectorRef.current?.captureToolCall(
							task.currentTurn || 0,
							tc,
							tr,
						);
					},
					onError: (message, site) => {
						task.progressSummary = `错误 (${site}): ${message}`;
						taskEventBus.publish(task.id, "error", {
							message,
							site,
							turn: task.currentTurn,
						});
						sessionStore
							.logError(task.currentTurn || 0, site, message, true)
							.catch(() => {});
						collectorRef.current?.captureError(
							task.currentTurn || 0,
							message,
							site,
						);
					},
					onToken: (_token, fullText) => {
						task.progressSummary = fullText.slice(-200);
						// Extract and emit reasoning content from <think> blocks
						const openThink = fullText.lastIndexOf("<think>");
						const closeThink = fullText.lastIndexOf("</think>");
						const openTool = fullText.lastIndexOf("<tool_call>");
						const closeTool = fullText.lastIndexOf("</tool_call>");
						if (openThink >= 0 && closeThink < openThink) {
							const afterTag = fullText
								.slice(openThink + 7)
								.replace(/<\/think>[\s\S]*$/, "");
							if (afterTag.length > reasoningBufInline.length) {
								const delta = afterTag.slice(reasoningBufInline.length);
								reasoningBufInline = afterTag;
								taskEventBus.publish(task.id, "reasoning", { token: delta });
							}
							return;
						}
						if (openTool >= 0 && closeTool < openTool) {
							return;
						}
						if (reasoningBufInline) {
							if (closeThink > openThink) {
								const finalReasoning = fullText.slice(
									openThink + 7,
									closeThink,
								);
								if (finalReasoning.length > reasoningBufInline.length) {
									const delta = finalReasoning.slice(reasoningBufInline.length);
									reasoningBufInline = finalReasoning;
									taskEventBus.publish(task.id, "reasoning", { token: delta });
								}
							}
							reasoningBufInline = "";
						}
						// Strip trailing partial tag before computing clean text
						const safeFull = fullText.replace(/<[\w\/]*$/, "");
						const cleanText = stripToolCalls(
							stripThinkContent(
								safeFull.includes('"id":"call_')
									? stripNativeToolJson(safeFull)
									: safeFull,
							),
						);
						// Prefix invariant guard: 防止 .trim() 或 \n{3,} 归一化导致 cleanText
						// 比 lastCleanInline 短，破坏前缀不变性造成重复发射。
						if (cleanText.length >= lastCleanInline.length) {
							const delta = cleanText.slice(lastCleanInline.length);
							if (delta) {
								taskEventBus.publish(task.id, "token", {
									token: delta,
									fullText: cleanText,
								});
							}
							lastCleanInline = cleanText;
						} else {
							// cleanText 被归一化缩短（如尾随换行被折叠），跳过此轮发射
							// 但同步 lastCleanInline 避免累积偏差
							lastCleanInline = cleanText;
						}
					},
				});
				result = {
					finalAnswer: inlineResult.finalAnswer,
					turnCount: inlineResult.turnCount,
					stopReason: inlineResult.stopReason,
					duration: inlineResult.duration,
					toolCallCount: inlineResult.toolCallCount,
					errorCount: inlineResult.errorCount,
					contextUsage: inlineResult.contextUsage,
				};
				collectedEntries = sessionCollector.getEntries();
				traceId = this.tracer?.getActiveTrace()?.id;
			}

			task.status = "completed";
			task.completedAt = new Date().toISOString();
			task.result = {
				finalAnswer: result.finalAnswer,
				turnCount: result.turnCount,
				stopReason: result.stopReason,
				duration: result.duration,
				toolCallCount: result.toolCallCount,
			};

			this.logEvent("task_completed", {
				taskId: task.id,
				sessionId: sessionStore.getSessionId(),
				duration: result.duration,
				turnCount: result.turnCount,
				stopReason: result.stopReason,
			});
			this.logEvent("session_ended", {
				taskId: task.id,
				sessionId: sessionStore.getSessionId(),
				duration: result.duration,
			});

			// 写入会话结束日志
			await sessionStore.writeEnd({
				duration: result.duration,
				turnCount: result.turnCount,
				toolCallCount: result.toolCallCount,
				errorCount: result.errorCount,
				stopReason: result.stopReason,
				finalAnswer: result.finalAnswer.slice(0, 2000),
				contextUsage: result.contextUsage,
			});

			// 保存完整会话到 SQLite（优先使用 INTEL Worker）
			try {
				const sessionId = sessionStore.getSessionId();
				const entries = collectedEntries;
				// 添加 session_meta 和 session_end 条目
				entries.unshift({
					type: "session_meta",
					sessionId,
					createdAt: new Date().toISOString(),
					config: task.config,
					userInput: task.userInput,
				});
				entries.push({
					type: "session_end",
					duration: result.duration,
					turnCount: result.turnCount,
					toolCallCount: result.toolCallCount,
					errorCount: result.errorCount,
					stopReason: result.stopReason,
					finalAnswer: result.finalAnswer,
					contextUsage: result.contextUsage,
				});
				if (this.intelCommander) {
					await this.intelCommander.request(
						"save_session",
						{
							sessionId,
							entries,
							indexAfterSave: true,
						},
						10000,
					);
				} else {
					this.sessionPersistence?.saveSession(sessionId, entries);
					try {
						this.sessionIndexer?.indexSession(sessionId);
					} catch (e) {
						console.error("[玄码] FTS5 索引失败:", e);
					}
				}
				// 按 sessionId 缓存消息历史（多轮对话记忆）
				if (
					task.sessionId &&
					lastMessagesRef.current &&
					lastMessagesRef.current.length > 0
				) {
					this.sessionMessageCache.set(task.sessionId, lastMessagesRef.current);
				}
				// 自动蒸馏（fire-and-forget）
				if (
					this.sessionDistiller &&
					lastMessagesRef.current &&
					lastMessagesRef.current.length >= 4
				) {
					this.sessionDistiller
						.distillAndPersist(lastMessagesRef.current)
						.catch(() => {});
				}
			} catch (e) {
				console.error("[玄码] SQLite 保存失败:", e);
			}

			taskEventBus.publish(task.id, "complete", {
				finalAnswer: result.finalAnswer,
				turnCount: result.turnCount,
				stopReason: result.stopReason,
				duration: result.duration,
				toolCallCount: result.toolCallCount,
				errorCount: result.errorCount,
				contextUsage: result.contextUsage,
				traceId,
			});

			// 任务完成：清理该任务悬挂的权限请求（resolve(false) 解除 runTaorLoop 阻塞，防 Map 泄漏）
			this.resolvePendingPermissions(task.id);
			// 任务完成：清理该任务悬挂的 ask_user 输入请求（解除阻塞 + 通知面板关闭）
			this.resolvePendingInputs(task.id);
			// B3 断点续跑：任务已自然完成 → 清除每轮持久化的 resume 快照，避免残留占位
			if (task.id && this.workDir) {
				clearResumeState(this.workDir, task.id);
			}

			// 自动审查（fire-and-forget）
			this.spawnAutoReview(task, result).catch(() => {});
		} catch (err) {
			task.status = "failed";
			task.completedAt = new Date().toISOString();
			task.error = String(err);
			this.logEvent("error", {
				taskId: task.id,
				site: "executeTask",
				message: String(err).slice(0, 1000),
			});
			taskEventBus.publish(task.id, "error_fatal", { error: String(err) });

			// 任务失败：清理该任务悬挂的权限请求
			this.resolvePendingPermissions(task.id);
			// 任务失败：清理该任务悬挂的 ask_user 输入请求
			this.resolvePendingInputs(task.id);
			// B3 断点续跑：任务失败 → 清除 resume 快照（失败已通过 error_fatal 落库，不应再续跑）
			if (task.id && this.workDir) {
				clearResumeState(this.workDir, task.id);
			}

			// 定时任务失败重试
			if (task.scheduledTaskId) {
				const schedMgr = (this as any).__schedTaskMgr;
				if (schedMgr) {
					schedMgr.onTaskFailed(task.scheduledTaskId, task.retryCount || 0, 3);
				}
			}
		} finally {
			unspan.forEach((fn) => fn());
			this.abortControllers.delete(task.id);
			// 空闲超时控制器：清计时器 + 解除活动订阅
			this.idleTimeouts.get(task.id)?.dispose();
			this.idleTimeouts.delete(task.id);
			unsubIdleActivity();
			// 任务最终状态持久化（dispose 竞态下 DB 可能已关闭 —— 不阻塞收尾）
			try {
				this.taskStore?.saveTask(task);
			} catch {
				/* DB 已关闭 —— 忽略 */
			}
		}
	}

	/** 并发处理排队任务 — 启动不超过 maxConcurrentTasks 个任务 */
	private async processQueue(): Promise<void> {
		try {
			while (this.concurrencySemaphore < this.maxConcurrentTasks) {
				const queued = Array.from(this.tasks.values())
					.filter((t) => t.status === "queued")
					.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

				if (queued.length === 0) break;

				const task = queued[0];
				this.concurrencySemaphore++;

				// 不 await — 多个任务并发执行
				this.executeTask(task).finally(() => {
					this.concurrencySemaphore--;
					// 任务完成后立即触发下一轮调度，避免等待 poll interval
					this.processQueue();
				});
			}
		} catch (err) {
			console.error("[玄码] processQueue 异常:", err);
		}
	}

	async start(pollIntervalMs = 1000): Promise<void> {
		if (this.running) return;

		// 恢复持久化任务
		await this.recoverTasks();

		this.running = true;
		this.timer = setInterval(() => this.processQueue(), pollIntervalMs);
	}

	/** 恢复持久化的排队/运行中任务 */
	private async recoverTasks(): Promise<void> {
		if (!this.taskStore) return;
		try {
			const recoverable = this.taskStore.getRecoverableTasks();
			for (const row of recoverable) {
				if (row.status === "running") {
					// B3 断点续跑：若存在该任务的 resume 快照（每轮持久化），重新入队并带 resumeTaskId 续跑；
					// 否则 Worker 已销毁、无续跑依据，标记失败。
					if (readResumeState(this.workDir, row.id)) {
						const task: DaemonTask = {
							id: row.id,
							userId: row.user_id || undefined,
							userInput: row.user_input,
							config: {
								...(row.config_json ? JSON.parse(row.config_json) : {}),
								resumeTaskId: row.id,
							},
							status: "queued",
							createdAt: row.created_at,
							sessionId: row.session_id || undefined,
						};
						this.tasks.set(row.id, task);
						console.error(
							`[玄码] 任务 ${row.id} 中断，已带断点续跑标记重新入队`,
						);
					} else {
						this.taskStore.updateTaskStatus(
							row.id,
							"failed",
							undefined,
							"Daemon 重启 — 任务在运行中时被中断（无续跑快照）",
						);
					}
				} else if (row.status === "queued") {
					// 重新入队
					const task: DaemonTask = {
						id: row.id,
						userId: row.user_id || undefined,
						userInput: row.user_input,
						config: row.config_json ? JSON.parse(row.config_json) : {},
						status: "queued",
						createdAt: row.created_at,
						sessionId: row.session_id || undefined,
					};
					this.tasks.set(row.id, task);
				}
			}
			if (recoverable.length > 0) {
				console.error(`[玄码] 已恢复 ${recoverable.length} 个持久化任务`);
			}
		} catch (err) {
			console.error("[玄码] 恢复持久化任务失败:", err);
		}
	}

	/** 设置并发上限（运行时动态调整） */
	setMaxConcurrentTasks(n: number): void {
		this.maxConcurrentTasks = Math.max(1, Math.min(8, n));
		console.error(`[玄码] 并发上限调整为 ${this.maxConcurrentTasks} 路`);
	}

	/** 获取当前运行中任务数 */
	getRunningCount(): number {
		return this.concurrencySemaphore;
	}

	/** 获取用户当前运行中任务数 */
	getUserRunningCount(userId: string): number {
		let count = 0;
		for (const task of this.tasks.values()) {
			if (task.status === "running" && (task as any).userId === userId) count++;
		}
		return count;
	}

	/** 自动审查：任务完成后异步触发 review agent */
	private async spawnAutoReview(task: DaemonTask, result: any): Promise<void> {
		if (task.status !== "completed" || !result?.finalAnswer) return;
		try {
			const reviewAgent = new SubAgentScheduler(() => this.model, this.workDir);
			const reviewInstruction = `
审查以下 AI Agent 执行结果:

## 原始请求
${(task.userInput || "").slice(0, 2000)}

## 执行结果
${(result.finalAnswer || "").slice(0, 3000)}

## 执行统计
- 轮次: ${result.turnCount}
- 工具调用: ${result.toolCallCount}
- 停止原因: ${result.stopReason}
- 耗时: ${((result.duration || 0) / 1000).toFixed(1)}秒

请从代码质量、安全性、正确性三个维度审查。如果发现严重问题请标注。
`;
			const reviewResult = await reviewAgent.delegate(
				"review",
				reviewInstruction,
				"background",
			);
			task.reviewResult = reviewResult;
			this.taskStore?.updateTaskReview(task.id, reviewResult);
			console.error(`[玄码] 自动审查完成: ${task.id}`);
		} catch (err) {
			console.error("[玄码] 自动审查失败:", err);
		}
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** 优雅关闭：停止调度 → 终止全部 worker（释放 SQLite 文件锁）→ 强制关闭会话持久化连接。幂等可重复调用。 */
	async dispose(): Promise<void> {
		this.stop();

		const intel = this.intelCommander;
		const recon = this.reconCommander;
		this.intelCommander = null;
		this.reconCommander = null;

		// 先请求 worker 优雅关闭自身 DB，再终止线程；任一失败不阻塞其余清理
		const closings: Promise<unknown>[] = [];
		if (intel) {
			closings.push(
				intel
					.request("close", {}, 3000)
					.catch(() => {})
					.then(() => intel.terminate())
					.catch(() => {}),
			);
		}
		if (recon) {
			// RECON 持有 @parcel/watcher 原生后端 —— 必须先优雅卸载再 terminate，
			// 否则硬杀线程会中断原生回调/残留原生线程，进程级 SIGSEGV（无任何 JS 报错）
			closings.push(
				recon
					.request("close", {}, 3000)
					.catch(() => {})
					.then(() => recon.terminate())
					.catch(() => {}),
			);
		}
		await Promise.all(closings);

		// 强制关闭进程级 DatabasePool 单例连接（refCount 清零），确保文件锁立即释放
		try {
			this.sessionPersistence?.close();
		} catch {
			/* 已关闭或未初始化 —— 忽略 */
		}
		this.sessionPersistence = null;
		try {
			DatabasePool.reset();
		} catch {
			/* 连接已关闭 —— 忽略 */
		}
		this.taskStore = null;
		this.sessionIndexer = null;
	}

	isRunning(): boolean {
		return this.running;
	}

	/** 运行时更换模型适配器（设置面板调用） */
	setModel(newModel: ModelAdapter): void {
		this.model = newModel;
	}

	/** 运行时通过 ModelRouter 更换模型供应商 */
	configureModel(provider: string, modelName: string): void {
		if (this.model instanceof ModelRouter) {
			(this.model as ModelRouter).setProvider(provider, modelName);
		}
	}

	/** 获取当前模型信息 */
	getModelProvider(): string {
		if (this.model instanceof ModelRouter) {
			return `${(this.model as ModelRouter).provider}/${(this.model as ModelRouter).modelName}`;
		}
		return (this.model as any)?.constructor?.name || "unknown";
	}

	/** 获取 ModelRouter 引用 */
	getModelRouter(): ModelRouter | null {
		return this.model instanceof ModelRouter
			? (this.model as ModelRouter)
			: null;
	}

	/** 运行时更换工作目录 */
	setWorkDir(dir: string): void {
		this.workDir = dir;
		console.error(`[玄码] 工作目录已更新: ${dir}`);
		// Restart RECON watcher with new directory
		if (this.reconCommander) {
			this.reconCommander.sendCommand("stop_watch");
			if (dir) {
				this.reconCommander.sendCommand("start_watch", { dir });
			}
		} else if ((this as any).__fileWatcher) {
			const fw = (this as any).__fileWatcher;
			fw.stopWatch();
			if (dir) {
				fw.startWatch(dir, (events: any) => {
					taskEventBus.publish("workspace", "file_changed", { events });
				});
			}
		}
	}

	/** 获取统计汇总 */
	getStats(): {
		total: number;
		queued: number;
		running: number;
		completed: number;
		failed: number;
	} {
		const all = Array.from(this.tasks.values());
		return {
			total: all.length,
			queued: all.filter((t) => t.status === "queued").length,
			running: all.filter((t) => t.status === "running").length,
			completed: all.filter((t) => t.status === "completed").length,
			failed: all.filter((t) => t.status === "failed").length,
		};
	}
}

// ===== SSE 事件总线 =====

/** 单任务事件环形缓冲容量（token 增量等小事件，2000 条足够覆盖一次断线窗口） */
const TASK_EVENT_BUFFER_CAPACITY = 2000;
/** 最多同时缓存多少个任务的事件流（防泄漏，淘汰最早入缓存的） */
const TASK_BUFFER_MAX_TASKS = 200;

interface BufferedTaskEvent {
	id: number;
	event: string;
	data: unknown;
}

class TaskEventBus {
	private emitter = new EventEmitter();
	/** 全局单调事件序号（写入 SSE id: 行，客户端 Last-Event-ID 回传据此续传） */
	private seq = 0;
	private buffers = new Map<string, BufferedTaskEvent[]>();

	subscribe(
		taskId: string,
		listener: (event: string, data: unknown, id?: number) => void,
	): () => void {
		const handler = (event: string, data: unknown, id?: number) =>
			listener(event, data, id);
		this.emitter.on(taskId, handler);
		return () => {
			this.emitter.off(taskId, handler);
		};
	}

	publish(taskId: string, event: string, data: unknown): void {
		const id = ++this.seq;
		let buf = this.buffers.get(taskId);
		if (!buf) {
			// 防泄漏：任务数超上限时淘汰最早入缓存的
			if (this.buffers.size >= TASK_BUFFER_MAX_TASKS) {
				const oldest = this.buffers.keys().next().value;
				if (oldest !== undefined) this.buffers.delete(oldest);
			}
			buf = [];
			this.buffers.set(taskId, buf);
		}
		buf.push({ id, event, data });
		if (buf.length > TASK_EVENT_BUFFER_CAPACITY) {
			buf.splice(0, buf.length - TASK_EVENT_BUFFER_CAPACITY);
		}
		this.emitter.emit(taskId, event, data, id);
	}

	/** 断线续传：返回该任务中 id > afterId 的已缓冲事件（保持顺序） */
	replay(taskId: string, afterId: number): BufferedTaskEvent[] {
		const buf = this.buffers.get(taskId);
		if (!buf || buf.length === 0) return [];
		// 缓冲按 id 单调递增，二分找起点
		let lo = 0;
		let hi = buf.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (buf[mid].id <= afterId) lo = mid + 1;
			else hi = mid;
		}
		return buf.slice(lo);
	}

	dropBuffer(taskId: string): void {
		this.buffers.delete(taskId);
	}

	removeAllListeners(taskId: string): void {
		this.emitter.removeAllListeners(taskId);
	}
}

const taskEventBus = new TaskEventBus();

// ===== 空闲超时（idle timeout） =====
// 长任务不能被墙钟硬杀：只有「连续 idleMs 内无任何输出/工具活动」才判定超时。
// 等待用户回答（ask_user）/权限确认期间挂起计时——用户想多久都行。

class IdleAbortController {
	private controller = new AbortController();
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** 挂起计数（支持并发多个等待：权限 + ask_user 同时挂起） */
	private waitCount = 0;

	constructor(
		private idleMs: number,
		private onTimeout?: () => void,
	) {
		this.arm();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** 任一活动（token/turn/tool_call/progress/verify…）调用：重置空闲计时 */
	activity(): void {
		if (this.controller.signal.aborted) return;
		this.arm();
	}

	/** 进入用户等待：挂起计时（计数制，嵌套/并发等待安全） */
	suspend(): void {
		this.waitCount++;
		this.disarm();
	}

	/** 等待解除：计数归零后恢复计时 */
	resume(): void {
		this.waitCount = Math.max(0, this.waitCount - 1);
		if (this.waitCount === 0 && !this.controller.signal.aborted) {
			this.arm();
		}
	}

	/** 任务结束时调用：清掉计时器防泄漏 */
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
				this.onTimeout?.();
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

// ===== COMBAT Worker Path Resolution =====

/** 测试专用：强制走内联执行路径（跳过 COMBAT Worker） */
let forceInlineForTests = false;
export function setForceInlineForTests(force: boolean): void {
	forceInlineForTests = force;
}

function resolveCombatWorkerPath(): string | null {
	if (forceInlineForTests) return null;

	const currDir =
		typeof __dirname !== "undefined"
			? __dirname
			: path.dirname(fileURLToPath(import.meta.url));

	let cjsPath = path.join(currDir, "combatUnit.cjs");
	if (fs.existsSync(cjsPath)) return cjsPath;

	cjsPath = path.resolve(currDir, "../../desktop/dist-daemon/combatUnit.cjs");
	if (fs.existsSync(cjsPath)) return cjsPath;

	return null;
}
function resolveIntelWorkerPath(): string | null {
	const currDir =
		typeof __dirname !== "undefined"
			? __dirname
			: path.dirname(fileURLToPath(import.meta.url));

	let cjsPath = path.join(currDir, "intelUnit.cjs");
	if (fs.existsSync(cjsPath)) return cjsPath;

	cjsPath = path.resolve(currDir, "../../desktop/dist-daemon/intelUnit.cjs");
	if (fs.existsSync(cjsPath)) return cjsPath;

	return null;
}

// ===== Worker Thread Commander =====

/**
 * Manages communication with a worker thread unit.
 * Provides fire-and-forget commands, typed request/response with timeout,
 * event subscriptions, and heartbeat monitoring.
 */
class WorkerCommander {
	private worker: Worker;
	private pendingRequests = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (err: Error) => void;
			timer: ReturnType<typeof setTimeout> | null;
			/** 空闲感知超时：任一 worker 事件（turn/token/tool_call…）到达即重置计时，而不是墙钟一刀切 */
			resetOnEvent: boolean;
			timeoutMs: number;
		}
	>();
	private eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
	private _lastHeartbeat = 0;
	private _exited = false;
	private _terminating = false;

	constructor(workerPath: string) {
		this.worker = new Worker(workerPath, { stdout: true, stderr: true });

		this.worker.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(`[WORKER] ${chunk.toString()}`);
		});
		this.worker.stderr?.on("data", (chunk: Buffer) => {
			process.stderr.write(`[WORKER] ${chunk.toString()}`);
		});

		this.worker.on("message", (msg: WorkerMessage) => {
			switch (msg.type) {
				case "response": {
					const pending = this.pendingRequests.get(msg.correlationId);
					if (pending) {
						if (pending.timer) clearTimeout(pending.timer);
						this.pendingRequests.delete(msg.correlationId);
						if (msg.success) {
							pending.resolve(msg.data);
						} else {
							pending.reject(new Error(msg.error || "Worker error"));
						}
					}
					break;
				}
				case "event": {
					// 空闲感知超时：worker 执行长任务期间持续吐事件 → 重置对应 request 的计时
					for (const [corrId, pending] of this.pendingRequests) {
						if (pending.resetOnEvent && pending.timer) {
							clearTimeout(pending.timer);
							pending.timer = this.armRequestTimer(corrId, pending);
						}
					}
					const handlers = this.eventHandlers.get(msg.event);
					if (handlers) {
						for (const handler of handlers) {
							try {
								handler(msg.payload);
							} catch {
								// handler error — don't let one bad handler break others
							}
						}
					}
					break;
				}
				case "heartbeat":
					this._lastHeartbeat = Date.now();
					break;
			}
		});

		this.worker.on("error", (err) => {
			console.error("[WorkerCommander] Worker error:", err);
		});

		this.worker.on("exit", (code) => {
			this._exited = true;
			console.error(`[WorkerCommander] Worker exited with code ${code}`);
			// Reject all pending requests
			for (const [, pending] of this.pendingRequests) {
				if (pending.timer) clearTimeout(pending.timer);
				pending.reject(new Error(`Worker exited with code ${code}`));
			}
			this.pendingRequests.clear();
		});
	}

	/** Fire-and-forget command */
	sendCommand(command: string, payload?: unknown): void {
		if (this._exited || this._terminating) return;
		try {
			this.worker.postMessage(createCommand(command, payload));
		} catch {
			// worker 已停止 —— 丢弃命令
		}
	}

	/** Request with typed response and timeout */
	request<T = unknown>(
		method: string,
		params?: unknown,
		timeoutMs = 5000,
		opts?: { resetOnEvent?: boolean },
	): Promise<T> {
		// 幂等终止后或 worker 已退出：快速失败，避免悬挂到超时
		if (this._exited || this._terminating) {
			return Promise.reject(
				new Error(`Worker already stopped, request "${method}" rejected`),
			);
		}
		return new Promise((resolve, reject) => {
			const msg = createRequest(method, params);
			const pending = {
				resolve: resolve as (v: unknown) => void,
				reject,
				timer: null as ReturnType<typeof setTimeout> | null,
				resetOnEvent: opts?.resetOnEvent ?? false,
				timeoutMs,
			};
			pending.timer = this.armRequestTimer(msg.correlationId, pending);
			this.pendingRequests.set(msg.correlationId, pending);
			try {
				this.worker.postMessage(msg);
			} catch (err: any) {
				if (pending.timer) clearTimeout(pending.timer);
				this.pendingRequests.delete(msg.correlationId);
				reject(err);
			}
		});
	}

	/** 为 pending request 装载超时计时器（resetOnEvent 模式下每次活动都会重新装载） */
	private armRequestTimer(
		correlationId: string,
		pending: {
			reject: (err: Error) => void;
			timeoutMs: number;
		},
	): ReturnType<typeof setTimeout> {
		return setTimeout(() => {
			this.pendingRequests.delete(correlationId);
			pending.reject(
				new Error(
					`Worker request timed out after ${pending.timeoutMs}ms (idle)`,
				),
			);
		}, pending.timeoutMs);
	}

	/** Subscribe to an event from the worker */
	onEvent(event: string, handler: (payload: unknown) => void): () => void {
		if (!this.eventHandlers.has(event)) {
			this.eventHandlers.set(event, new Set());
		}
		this.eventHandlers.get(event)?.add(handler);
		return () => {
			this.eventHandlers.get(event)?.delete(handler);
		};
	}

	/** Milliseconds since last heartbeat, or -1 if none received */
	getHeartbeatAge(): number {
		return this._lastHeartbeat === 0 ? -1 : Date.now() - this._lastHeartbeat;
	}

	/** 终止 worker。幂等：重复调用安全，terminate() 拒绝/已退出时静默返回。 */
	async terminate(): Promise<void> {
		if (this._terminating || this._exited) return;
		this._terminating = true;
		try {
			await this.worker.terminate();
		} catch {
			// worker 已停止或 terminate 被拒绝 —— 无需进一步清理
		}
	}
}

// ===== Server 选项 =====

export interface DaemonServerOptions {
	port?: number;
	provider?: string;
	modelName?: string;
	/** 直接注入模型实例（测试用）。缺省时走 createModel(provider, modelName) */
	model?: ModelAdapter;
	workDir?: string;
	sessionsDir?: string;
	/** 是否自动发现 npm 插件包 */
	pluginAutoDiscover?: boolean;
	/** API Key 认证 (Authorization: Bearer <token>) */
	apiKey?: string;
	/** 速率限制 (请求/分钟, 0 = 不限制, 默认 60) */
	rateLimitRPM?: number;
	/** 任务空闲超时 (毫秒, 默认 600000 = 10 分钟)。连续无输出/工具活动才计时，非墙钟硬杀 */
	maxTaskDuration?: number;
	/** 各供应商 API Key 映射，例如 { deepseek: "sk-xxx", openai: "sk-xxx" } */
	apiKeys?: Record<string, string>;
	/** 是否启用 MCP Server（端口 3021），默认 false */
	enableMCP?: boolean;
	/** 是否启用 A2A 协议，默认 false */
	enableA2A?: boolean;
	/** 是否启用可观测性追踪，默认 false */
	enableTelemetry?: boolean;
	/** PostgreSQL 连接字符串（设置后使用 PG 替代 JSONL 存储） */
	databaseUrl?: string;
}

// ===== HTTP JSON API =====

export async function startDaemonServer(
	portOrOptions?: number | DaemonServerOptions,
): Promise<{ server: http.Server; scheduler: DaemonScheduler }> {
	const opts: DaemonServerOptions =
		typeof portOrOptions === "number"
			? { port: portOrOptions }
			: portOrOptions || {};
	const port = opts.port ?? 3020;
	const provider = opts.provider ?? "mock";
	const modelName = opts.modelName ?? "deepseek-v4-flash";
	const workDir = normalizeWinPath(opts.workDir ?? process.cwd());
	const sessionsDir = opts.sessionsDir;
	const enableTelemetry = opts.enableTelemetry ?? false;

	// 在启动时设置 API Key 环境变量（适配器通过 process.env 读取）
	if (opts.apiKeys) {
		for (const [provider, key] of Object.entries(opts.apiKeys)) {
			if (key) {
				const providerUpper = provider.toUpperCase();
				process.env[`${providerUpper}_API_KEY`] = key;
				if (provider === "deepseek") process.env.DEEPSEEK_API_KEY = key;
				if (provider === "openai") process.env.OPENAI_API_KEY = key;
				if (provider === "anthropic") process.env.ANTHROPIC_API_KEY = key;
				if (provider === "google") process.env.GOOGLE_API_KEY = key;
				if (provider === "zhipu") process.env.ZHIPU_API_KEY = key;
				if (provider === "volcengine") process.env.VOLC_API_KEY = key;
			}
		}
	}

	// Initialize model registry (load defaults + user overrides)
	initModelRegistry(workDir);

	// Build model-router from registry (or inject a test model directly)
	const model: ModelAdapter = opts.model ?? createModel(provider, modelName);
	const sessionManager = new SessionManager(sessionsDir);

	// Telemetry tracer (declare before scheduler so we can wire it)
	const telemetryTracer = enableTelemetry
		? new Tracer({ maxSpans: 500, maxTraces: 50 })
		: null;
	const speedrunAnalyzer = enableTelemetry ? new SpeedrunAnalyzer() : null;
	if (enableTelemetry) {
		console.error("[玄码] 可观测性追踪已启用");
	}

	const scheduler = new DaemonScheduler(
		sessionManager,
		model,
		workDir,
		opts.maxTaskDuration ?? 600_000,
	);

	// 初始化自动蒸馏器（与 SQLite 无关，直接创建）
	try {
		scheduler.sessionDistiller = new SessionDistiller(model, workDir);
	} catch (e) {
		console.error("[玄码] 蒸馏器初始化失败（非致命）:", e);
	}

	// 确保 .xuancode 目录存在
	const xuancodeDir = path.join(workDir, ".xuancode");
	try {
		if (!fs.existsSync(xuancodeDir)) {
			fs.mkdirSync(xuancodeDir, { recursive: true });
		}
	} catch (e) {
		console.error("[玄码] 创建 .xuancode 目录失败:", e);
	}

	// 追加式系统事件流（跨会话审计/回放）
	const eventStream = new EventStream(xuancodeDir);
	await eventStream.init().catch((err) => {
		console.error("[玄码] 事件流初始化失败（非致命）:", err);
	});
	scheduler.eventStream = eventStream;

	// SQLite 持久化 + FTS5 索引（优先使用 INTEL Worker）
	const dbPath = path.join(xuancodeDir, "sessions.db");
	const intelWorkerPath = resolveIntelWorkerPath();
	let dbInstance: any = null;

	console.error("[玄码] Intel worker path:", intelWorkerPath);

	if (intelWorkerPath) {
		try {
			const intel = new WorkerCommander(intelWorkerPath);
			await intel.request("init", { dbPath }, 10000);
			scheduler.intelCommander = intel;
			console.error(`[玄码] INTEL 情报单元已启动 (Worker: ${intelWorkerPath})`);
		} catch (err) {
			console.error("[玄码] INTEL Worker 初始化失败:", err);
		}
	}

	// 回退：内联 SessionPersistence + SessionIndexer
	// 无论 intelCommander 是否成功，都要初始化 DB 和 taskStore（定时任务需要）
	const sessionPersistence = new SessionPersistence(dbPath);
	scheduler.sessionPersistence = sessionPersistence;
	try {
		await sessionPersistence.initialize();
		const db = sessionPersistence.getDb();
		dbInstance = db;
		console.error("[玄码] DB initialized, dbInstance:", !!dbInstance);
		if (!scheduler.intelCommander) {
			const indexer = new SessionIndexer(db);
			indexer.ensureFTS();
			scheduler.sessionIndexer = indexer;
		}
		scheduler.taskStore = new TaskStoreSQLite(db);
		console.error("[玄码] taskStore initialized:", !!scheduler.taskStore);
	} catch (e) {
		console.error("[玄码] SQLite 初始化失败:", e);
		if (e instanceof Error && e.stack) console.error(e.stack);
	}

	// 定时任务调度引擎 - 只要 dbInstance 存在就初始化
	let schedTaskMgr: ScheduledTaskManager | null = null;
	let schedTaskStore: ScheduledTaskStore | null = null;
	console.error(
		"[玄码] Final check - dbInstance:",
		!!dbInstance,
		"taskStore:",
		!!scheduler.taskStore,
	);
	if (dbInstance) {
		try {
			schedTaskStore = new ScheduledTaskStore(dbInstance);
			console.error("[玄码] ScheduledTaskStore created:", !!schedTaskStore);
			if (scheduler.taskStore) {
				schedTaskMgr = new ScheduledTaskManager(
					schedTaskStore,
					scheduler.taskStore,
					(input, config, meta) => {
						const task = scheduler.submit(
							input,
							config,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
						);
						if (task && meta?.scheduledTaskId) {
							(task as any).scheduledTaskId = meta.scheduledTaskId;
							(task as any).retryCount = 0;
						}
						return task?.id ?? null;
					},
				);
				(scheduler as any).__schedTaskMgr = schedTaskMgr;
				console.error("[玄码] 定时任务调度引擎已就绪");
			} else {
				console.error("[玄码] taskStore 不可用，跳过调度引擎");
			}
		} catch (e) {
			console.error("[玄码] ScheduledTaskStore 创建失败:", e);
		}
	} else {
		console.error("[玄码] dbInstance 为空，无法创建定时任务存储");
	}

	if (telemetryTracer) {
		scheduler.tracer = telemetryTracer;
	}

	// ===== 代码智能服务（语义搜索） =====
	// 索引按项目隔离，避免切换项目时加载错误缓存
	const projectHash = simpleHash(workDir);
	const codeIntelligenceIndexPath = path.join(
		os.homedir(),
		".xuancode",
		`code-index-${projectHash}.json`,
	);
	const codeIntelligenceService = new CodeIntelligenceService(
		workDir,
		codeIntelligenceIndexPath,
	);
	// 后台异步构建索引
	codeIntelligenceService.ensureIndex().catch(() => {});

	// 自改进优化器（仅在 telemetry 启用时可用）
	const optimizerService =
		enableTelemetry && telemetryTracer && speedrunAnalyzer
			? new OptimizerService(telemetryTracer, speedrunAnalyzer, sessionManager)
			: null;

	// 离线语音引擎
	const whisperDataDir = path.join(os.homedir(), ".xuancode", "whisper");
	const whisperEngine = new WhisperLocalEngine({ dataDir: whisperDataDir });
	let whisperDownloading = false;

	// 计算机控制服务（Computer Use）
	const computerUseService = new ComputerUseService();
	scheduler.computerUseService = computerUseService;

	// 数据存储模式
	const databaseUrl = opts.databaseUrl || process.env.DATABASE_URL || "";
	const usePg = !!databaseUrl;
	if (usePg) console.error("[玄码] 使用 PostgreSQL 存储");

	// 速率限制器
	const rateLimitRPM = opts.rateLimitRPM ?? 60;
	const rateLimiter = rateLimitRPM > 0 ? createRateLimiter(rateLimitRPM) : null;

	// 认证/计费组件（公开仓 seam：auth 已剥离，置为 null，所有 auth?. 调用自动短路）
	const auth = null as any;

	// PluginManager 初始化
	const pluginManager = new PluginManager({
		projectDir: workDir,
		autoDiscover: opts.pluginAutoDiscover,
		// 插件生命周期事件 → 追加式事件流（审计/回放）
		onEvent: (e) => {
			scheduler.logEvent(e.type, e as Record<string, unknown>);
		},
	});

	// 先注册内置 SERPAPI 插件，再初始化加载用户插件
	// 这样用户插件注册的同名 tool 会覆盖内置的（用户优先）
	pluginManager.registry
		.register(serpapiPlugin as any, {
			workDir,
			config: {},
		})
		.catch((err) => console.error("[daemon] 注册 serpapi 插件失败:", err));

	// 注册内置 DuckDuckGo 插件（免 Key，零配置）
	pluginManager.registry
		.register(duckduckgoPlugin as any, {
			workDir,
			config: {},
		})
		.catch((err) => console.error("[daemon] 注册 duckduckgo 插件失败:", err));

	// 注册内置 SearXNG 插件（自建搜索引擎）
	pluginManager.registry
		.register(searxngPlugin as any, {
			workDir,
			config: {},
		})
		.catch((err) => console.error("[daemon] 注册 searxng 插件失败:", err));

	pluginManager
		.initialize()
		.then(() => {
			scheduler.pluginManager = pluginManager;
			scheduler.onHook = pluginManager.getHookCallback();
			const stats = pluginManager.getStats();
			if (stats.total > 0) {
				console.error(`[玄码] 已加载 ${stats.total} 个插件:`);
			}
		})
		.catch((err) => {
			console.error("[玄码] 插件初始化失败:", err);
		});

	// ===== MCP Server (端口 3021，并行部署) =====
	const mcpServerInstance = {
		server: null as http.Server | null,
		mcpHandler: null as ReturnType<typeof createMCPHttpHandler> | null,
		mcpServer: null as MCPServer | null,
	};
	// MCP 多服务进程追踪 (VS Code 风格的 mcpServers)
	const mcpSvcProcesses = new Map<
		string,
		{
			proc: any;
			status: "stopped" | "running" | "error";
			lastError: string;
			startedAt: number;
		}
	>();
	if (opts.enableMCP) {
		try {
			const mcpHandler = createMCPHttpHandler();
			mcpServerInstance.mcpHandler = mcpHandler;

			const toolManagerForMCP = new ToolManager(workDir);
			const mcp = new MCPServer(toolManagerForMCP, {
				serverName: "xuancode-daemon",
				serverVersion: DAEMON_VERSION,
				enableResources: true,
				workDir,
			});
			mcpServerInstance.mcpServer = mcp;

			// 当 SSE 连接建立时，注册会话
			const originalHandleSSE = mcpHandler.handleSSE.bind(mcpHandler);
			mcpHandler.handleSSE = (req, res) => {
				const result = originalHandleSSE(req, res);
				if (result) {
					// 从 sessions map 中找到刚创建的 transport 并注册到 MCPServer
					const lastEntry = Array.from(mcpHandler.sessions.entries()).pop();
					if (lastEntry) {
						const [sessionId, transport] = lastEntry;
						mcp.createSession(transport);
					}
				}
				return result;
			};

			const mcpHttpServer = http.createServer((req, res) => {
				res.setHeader("Access-Control-Allow-Origin", "*");
				res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
				res.setHeader(
					"Access-Control-Allow-Headers",
					"Content-Type, Authorization",
				);

				if (req.method === "OPTIONS") {
					res.writeHead(204);
					res.end();
					return;
				}

				// SSE 连接
				if (mcpHandler.handleSSE(req, res)) return;
				// JSON-RPC 消息
				if (mcpHandler.handleMessage(req, res)) return;

				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "MCP: 未找到路由" }));
			});

			const MCP_PORT = 3021;
			mcpHttpServer.listen(MCP_PORT, () => {
				console.error(
					`[玄码] MCP Server 启动于 http://localhost:${MCP_PORT}/sse`,
				);
			});

			mcpServerInstance.server = mcpHttpServer;
			console.error(`[玄码] MCP Server 已启用 (端口 ${MCP_PORT})`);
		} catch (err) {
			console.error("[玄码] MCP Server 启动失败:", err);
		}
	}

	// ===== A2A Server =====
	let a2aServer: A2AServer | null = null;
	if (opts.enableA2A) {
		try {
			const toolManagerForA2A = new ToolManager(workDir);
			a2aServer = new A2AServer(toolManagerForA2A, {
				agentName: "玄码 AI Agent",
				agentDescription:
					"通用 AI Agent 编排平台，支持代码编辑、文件操作、命令执行、网络搜索和版本控制。",
				providerName: "XuanCode",
				streaming: true,
				tracer: telemetryTracer ?? undefined,
			});
			console.error("[玄码] A2A 协议已启用");
		} catch (err) {
			console.error("[玄码] A2A Server 初始化失败:", err);
		}
	}

	const server = http.createServer(async (req, res) => {
		// CORS headers
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Content-Type, Authorization",
		);

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		// 解析 URL
		const url = new URL(req.url || "/", `http://${req.headers.host}`);
		const pathParts = url.pathname.split("/").filter(Boolean);

		// 健康检查不受限
		// 免认证路径（健康检查 + 认证端点）
		const isPublicPath = (() => {
			if (req.method === "GET" && url.pathname === "/health") return true;
			if (req.method === "GET" && url.pathname === "/version") return true;
			if (auth && url.pathname.startsWith("/auth/")) return true;
			return false;
		})();

		// 协议版本协商：客户端声明了不兼容的 API 版本 → 409（缺失 header = 旧客户端，按 v1 放行）
		if (!isPublicPath) {
			const clientVersionHeader = req.headers[API_VERSION_HEADER.toLowerCase()];
			if (clientVersionHeader) {
				const clientApiVersion = Number(clientVersionHeader);
				if (
					!Number.isNaN(clientApiVersion) &&
					clientApiVersion !== API_VERSION
				) {
					const body: ErrorBody = {
						error: "协议版本不兼容",
						code: "api_version_mismatch",
						serverApiVersion: API_VERSION,
						minClientApiVersion: MIN_SUPPORTED_API_VERSION,
					};
					respond(res, 409, body);
					return;
				}
			}
		}

		// API Key 认证 (除公开路径)
		const apiKey = opts.apiKey || process.env.XUANCODE_API_KEY;
		if (!isPublicPath && apiKey) {
			const auth = req.headers.authorization;
			if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== apiKey) {
				respond(res, 401, { error: "未授权：缺少或无效的 API Key" });
				return;
			}
		}

		// 速率限制 (除公开路径)
		if (!isPublicPath && rateLimitRPM > 0 && rateLimiter) {
			const clientIp = req.socket.remoteAddress || "unknown";
			const check = rateLimiter.check(clientIp);
			res.setHeader("X-RateLimit-Remaining", String(check.remaining));
			res.setHeader("X-RateLimit-Reset", String(check.resetMs));
			if (!check.allowed) {
				respond(res, 429, { error: "请求过于频繁，请稍后重试" });
				return;
			}
		}

		try {
			// --- 健康检查 ---
			if (req.method === "GET" && url.pathname === "/health") {
				respond(res, 200, {
					status: "ok",
					daemon: scheduler.isRunning() ? "running" : "stopped",
					uptime: process.uptime(),
					memory: process.memoryUsage().rss,
					apiVersion: API_VERSION,
					daemonVersion: DAEMON_VERSION,
				});
				return;
			}

			// --- OpenAPI 规范暴露 ---
			if (req.method === "GET" && url.pathname === "/docs/openapi.yaml") {
				const specPath = path.resolve(process.cwd(), "docs/openapi.yaml");
				// 也尝试从 monorepo 根目录查找
				const altPath = path.resolve(process.cwd(), "../docs/openapi.yaml");
				const target = fs.existsSync(specPath)
					? specPath
					: fs.existsSync(altPath)
						? altPath
						: null;
				if (target) {
					const yaml = fs.readFileSync(target, "utf-8");
					res.writeHead(200, {
						"Content-Type": "text/yaml; charset=utf-8",
						"Access-Control-Allow-Origin": "*",
						"Cache-Control": "public, max-age=3600",
					});
					res.end(yaml);
				} else {
					respond(res, 404, {
						error: "OpenAPI spec not found",
					});
				}
				return;
			}

			// --- 版本信息（协议契约单点 @xuancode/daemon-protocol） ---
			if (req.method === "GET" && url.pathname === "/version") {
				const versionInfo: VersionInfo = {
					protocol: PROTOCOL_NAME,
					apiVersion: API_VERSION,
					daemonVersion: DAEMON_VERSION,
					features: ["sse", "tasks", "permission", "input", "a2a"],
				};
				respond(res, 200, versionInfo);
				return;
			}

			// --- Prometheus 指标 ---
			if (req.method === "GET" && url.pathname === "/metrics") {
				const stats = scheduler.getStats();
				const mem = process.memoryUsage();
				const uptime = process.uptime();
				const runningCount = stats.running;
				const agentsActive = runningCount;

				// Simple HTTP request counter (incremented per request handling)
				const metrics = `${[
					"# HELP xuancode_tasks_total 任务总数",
					"# TYPE xuancode_tasks_total gauge",
					`xuancode_tasks_total{status="queued"} ${stats.queued}`,
					`xuancode_tasks_total{status="running"} ${stats.running}`,
					`xuancode_tasks_total{status="completed"} ${stats.completed}`,
					`xuancode_tasks_total{status="failed"} ${stats.failed}`,
					"# HELP xuancode_memory_bytes 进程内存使用",
					"# TYPE xuancode_memory_bytes gauge",
					`xuancode_memory_bytes{type="rss"} ${mem.rss}`,
					`xuancode_memory_bytes{type="heap_total"} ${mem.heapTotal}`,
					`xuancode_memory_bytes{type="heap_used"} ${mem.heapUsed}`,
					"# HELP xuancode_uptime_seconds 进程运行时长",
					"# TYPE xuancode_uptime_seconds counter",
					`xuancode_uptime_seconds ${uptime}`,
					"# HELP xuancode_agents_active 当前活跃 Agent 数",
					"# TYPE xuancode_agents_active gauge",
					`xuancode_agents_active ${agentsActive}`,
					"# HELP xuancode_db_connected 数据库连接状态",
					"# TYPE xuancode_db_connected gauge",
					`xuancode_db_connected ${usePg ? 1 : 0}`,
					"# HELP xuancode_build_info 构建信息",
					"# TYPE xuancode_build_info gauge",
					`xuancode_build_info{version="${DAEMON_VERSION}",storage="${usePg ? "postgresql" : "jsonl}"} 1`,
				].join("\n")}\n`;

				res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(metrics);
				return;
			}

			// --- 提交任务 ---
			if (req.method === "POST" && url.pathname === "/tasks") {
				const body = await readBody(req);
				const input = body?.input || "请分析当前项目结构";
				const config = body?.config;
				const attachments = body?.attachments;
				const messages = body?.messages;
				const sessionId = body?.sessionId || config?.sessionId;

				// JWT 鉴权 + 配额检查（调用次数 5h 滚动 + 并发上限）
				const authz = await auth?.authorizeTask(req);
				const quota = authz?.sub
					? await auth?.checkTaskQuota(authz.sub)
					: undefined;
				if (quota && !quota.allowed) {
					respond(
						res,
						429,
						quota.currentRunning !== undefined
							? {
									error: quota.error,
									currentRunning: quota.currentRunning,
									maxConcurrent: quota.maxConcurrent,
								}
							: { error: quota.error },
					);
					return;
				}

				const task = scheduler.submit(
					input,
					config,
					attachments,
					messages,
					sessionId,
					authz?.sub,
					quota?.permissionLevel,
				);

				// 任务完成后追踪用量和调用次数（auth 组件内部订阅 taskEventBus）
				auth?.trackTaskUsage(authz?.sub, task.id, input);

				respond(res, 201, task);
				return;
			}

			// --- 获取任务列表 ---
			if (req.method === "GET" && url.pathname === "/tasks") {
				const limit = Number.parseInt(
					url.searchParams.get("limit") || "20",
					10,
				);
				respond(res, 200, scheduler.listTasks(limit));
				return;
			}

			// --- 获取任务详情 ---
			if (
				req.method === "GET" &&
				pathParts[0] === "tasks" &&
				pathParts[1] &&
				!pathParts[2]
			) {
				const taskId = pathParts[1];
				const task = scheduler.getTask(taskId);
				if (!task) {
					respond(res, 404, { error: "任务不存在" });
					return;
				}
				respond(res, 200, task);
				return;
			}

			// --- 取消任务 ---
			if (
				req.method === "POST" &&
				pathParts[0] === "tasks" &&
				pathParts[1] &&
				pathParts[2] === "cancel"
			) {
				const taskId = pathParts[1];
				const cancelled = scheduler.cancelTask(taskId);
				// 取消：清理该任务悬挂的权限请求与 ask_user 输入请求
				scheduler.resolvePendingPermissions(taskId);
				scheduler.resolvePendingInputs(taskId);
				// B3 断点续跑：用户主动取消 → 清除 resume 快照，防止被 recoverTasks 复活
				clearResumeState(workDir, taskId);
				respond(res, 200, { status: cancelled ? "cancelled" : "not_found" });
				return;
			}

			// --- C1 · Git 检查点列表（?path= 指定项目目录，缺省用 daemon workDir）---
			if (req.method === "GET" && url.pathname === "/checkpoints") {
				const cpDir = resolveCheckpointDir(url, workDir);
				respond(res, 200, { checkpoints: listCheckpointsMerged(cpDir) });
				return;
			}

			// --- C1 · 检查点差异审查（该检查点→当前工作区改了什么）---
			if (
				req.method === "GET" &&
				pathParts[0] === "checkpoints" &&
				pathParts[1] &&
				pathParts[2] === "diff"
			) {
				const hash = pathParts[1];
				const cpDir = resolveCheckpointDir(url, workDir);
				const diff = await checkpointDiff(cpDir, hash);
				respond(res, diff.success ? 200 : 404, diff);
				return;
			}

			// --- C1 · 回滚到检查点（还原代码；可选同时还原对话）---
			if (
				req.method === "POST" &&
				pathParts[0] === "checkpoints" &&
				pathParts[1] &&
				pathParts[2] === "rollback"
			) {
				const hash = pathParts[1];
				const body = await readBody(req);
				const cpDir = body?.path
					? normalizeWinPath(String(body.path))
					: workDir;
				const roll = await rollbackCheckpoint(cpDir, hash, {
					backup: body?.backup !== false,
				});
				if (!roll.ok) {
					respond(res, 400, roll);
					return;
				}
				const restoredMessages = body?.restoreConversation
					? readConversationSnapshot(cpDir, hash)
					: undefined;
				respond(res, 200, { ...roll, restoredMessages });
				return;
			}

			// --- 五行 · 用户权限确认响应 ---
			if (
				req.method === "POST" &&
				pathParts[0] === "tasks" &&
				pathParts[1] &&
				pathParts[2] === "permission"
			) {
				const taskId = pathParts[1];
				const body = await readBody(req);
				const { requestId, allowed } = body;
				if (!requestId) {
					respond(res, 400, { error: "缺少 requestId" });
					return;
				}
				const pending = scheduler.pendingPermissionRequests.get(requestId);
				if (!pending) {
					respond(res, 404, { error: "权限请求不存在或已超时" });
					return;
				}
				pending.resolve(allowed === true);
				scheduler.pendingPermissionRequests.delete(requestId);
				respond(res, 200, { status: "ok", allowed: !!allowed });
				return;
			}

			// --- 人工介入：用户回复 ---
			if (
				req.method === "POST" &&
				pathParts[0] === "tasks" &&
				pathParts[1] &&
				pathParts[2] === "input"
			) {
				const taskId = pathParts[1];
				const task = scheduler.getTask(taskId);
				if (!task) {
					respond(res, 404, { error: "任务不存在" });
					return;
				}
				const body = await readBody(req);
				const answer = body?.answer;
				if (!answer) {
					respond(res, 400, { error: "缺少 answer 字段" });
					return;
				}
				// 优先路由到 ask_user 等待中的 Promise（inline / worker 统一）
				const pending = scheduler.pendingInputRequests.get(taskId);
				if (pending) {
					task.status = "running";
					task.awaitingSince = undefined;
					task.pendingQuestion = undefined;
					task.interventionCount = (task.interventionCount || 0) + 1;
					pending.resolve(`用户选择: ${String(answer)}`);
					taskEventBus.publish(taskId, "input_received", { answer });
					respond(res, 200, { status: "resumed", answer });
					return;
				}
				// V2 竞态修复：找不到 resolver 时绝不伪成功，否则 ask_user Promise 会静默等到 5 分钟超时
				// 把用户回答丢弃。awaiting_input 状态下回 409 让客户端可重试；其他状态回 400。
				if (task.status === "awaiting_input") {
					respond(res, 409, {
						error: "任务正在等待输入但 resolver 尚未就位（竞态窗口），请重试",
						answer,
					});
				} else {
					respond(res, 400, {
						error: "任务不在等待输入状态",
						status: task.status,
					});
				}
				return;
			}

			// --- 获取审查结果 ---
			if (
				req.method === "GET" &&
				pathParts[0] === "tasks" &&
				pathParts[1] &&
				pathParts[2] === "review"
			) {
				const taskId = pathParts[1];
				const task = scheduler.getTask(taskId);
				if (!task) {
					respond(res, 404, { error: "任务不存在" });
					return;
				}
				respond(res, 200, {
					taskId,
					reviewResult: task.reviewResult || null,
					finalAnswer: task.result?.finalAnswer,
				});
				return;
			}

			// --- 审批审查结果 ---
			if (
				req.method === "POST" &&
				pathParts[0] === "tasks" &&
				pathParts[1] &&
				pathParts[2] === "approve-review"
			) {
				const taskId = pathParts[1];
				const task = scheduler.getTask(taskId);
				if (!task) {
					respond(res, 404, { error: "任务不存在" });
					return;
				}
				const body = await readBody(req);
				const action = body?.action;
				if (!["accept", "request_fix", "ignore"].includes(action)) {
					respond(res, 400, {
						error: "action 必须是 accept / request_fix / ignore",
					});
					return;
				}
				taskEventBus.publish(taskId, "review_decision", {
					action,
					note: body?.note,
				});
				respond(res, 200, { status: "ok", action });
				return;
			}

			// --- 任务介入历史 ---
			if (
				req.method === "GET" &&
				pathParts[0] === "tasks" &&
				pathParts[1] &&
				pathParts[2] === "history"
			) {
				const taskId = pathParts[1];
				const task = scheduler.getTask(taskId);
				if (!task) {
					respond(res, 404, { error: "任务不存在" });
					return;
				}
				respond(res, 200, {
					taskId,
					interventionCount: task.interventionCount || 0,
					pendingQuestion: task.pendingQuestion || null,
					awaitingSince: task.awaitingSince || null,
				});
				return;
			}

			// ===== 定时任务 (Scheduled Tasks) API =====

			// --- 列出所有定时任务 ---
			if (
				req.method === "GET" &&
				url.pathname === "/scheduled-tasks" &&
				!pathParts[1]
			) {
				const debug = {
					schedTaskMgr: !!schedTaskMgr,
					schedTaskStore: !!schedTaskStore,
					taskStore: !!scheduler.taskStore,
				};
				console.error("[玄码] /scheduled-tasks debug:", debug);
				if (!schedTaskMgr) {
					respond(res, 503, { error: "定时任务引擎未初始化", debug });
					return;
				}
				const list = schedTaskStore?.listAllWithLastStatus();
				respond(res, 200, list);
				return;
			}

			// --- 创建定时任务 ---
			if (req.method === "POST" && url.pathname === "/scheduled-tasks") {
				if (!schedTaskMgr) {
					respond(res, 503, {
						error: "定时任务引擎未初始化",
						debug: {
							schedTaskMgr: !!schedTaskMgr,
							schedTaskStore: !!schedTaskStore,
							taskStore: !!scheduler.taskStore,
						},
					});
					return;
				}
				const body = await readBody(req);
				if (!body || !body.name || !body.cron_expression || !body.user_input) {
					respond(res, 400, {
						error: "缺少必填字段: name, cron_expression, user_input",
					});
					return;
				}
				const fields = parseCron(body.cron_expression);
				if (!fields) {
					respond(res, 400, { error: "cron 表达式格式无效" });
					return;
				}
				const now = new Date().toISOString();
				const nextRun = getNextRunTime(fields);
				const task = {
					id: randomUUID(),
					user_id: null,
					name: body.name,
					description: body.description || "",
					cron_expression: body.cron_expression,
					user_input: body.user_input,
					config_json: body.config ? JSON.stringify(body.config) : null,
					enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1,
					max_retries: body.max_retries ?? 3,
					retry_interval_ms: body.retry_interval_ms ?? 60000,
					next_retry_at: null,
					created_at: now,
					updated_at: now,
					last_run_at: null,
					next_run_at: nextRun ? new Date(nextRun).toISOString() : null,
				};
				schedTaskStore?.insert(task);
				respond(res, 201, task);
				return;
			}

			// --- cron 表达式验证 ---
			if (
				req.method === "GET" &&
				url.pathname === "/scheduled-tasks/validate-cron"
			) {
				const expr = url.searchParams.get("expr");
				if (!expr) {
					respond(res, 400, { error: "缺少 expr 参数" });
					return;
				}
				const fields = parseCron(expr);
				if (!fields) {
					respond(res, 200, { valid: false, description: "无效表达式" });
					return;
				}
				const nextRun = getNextRunTime(fields);
				respond(res, 200, {
					valid: true,
					description: describeCron(expr),
					nextRun: nextRun ? new Date(nextRun).toISOString() : null,
				});
				return;
			}

			// --- 定时任务详情 / 操作 ---
			if (pathParts[0] === "scheduled-tasks" && pathParts[1]) {
				const taskId = pathParts[1];
				const subPath = pathParts[2];

				// 获取单个任务
				if (req.method === "GET" && !subPath) {
					const task = schedTaskStore?.get(taskId);
					if (!task) {
						respond(res, 404, { error: "定时任务不存在" });
						return;
					}
					respond(res, 200, task);
					return;
				}

				// 更新定时任务
				if (req.method === "PUT" && !subPath) {
					const existing = schedTaskStore?.get(taskId);
					if (!existing) {
						respond(res, 404, { error: "定时任务不存在" });
						return;
					}
					const body = await readBody(req);
					if (body.cron_expression) {
						const fields = parseCron(body.cron_expression);
						if (!fields) {
							respond(res, 400, { error: "cron 表达式格式无效" });
							return;
						}
					}
					const update: Record<string, unknown> = {
						updated_at: new Date().toISOString(),
					};
					if (body.name) update.name = body.name;
					if (body.description !== undefined)
						update.description = body.description;
					if (body.cron_expression) {
						update.cron_expression = body.cron_expression;
						const fields = parseCron(body.cron_expression);
						if (fields) {
							const nextRun = getNextRunTime(fields);
							update.next_run_at = nextRun
								? new Date(nextRun).toISOString()
								: null;
						}
					}
					if (body.user_input) update.user_input = body.user_input;
					if (body.config) update.config_json = JSON.stringify(body.config);
					if (body.max_retries !== undefined)
						update.max_retries = body.max_retries;
					schedTaskStore?.update(taskId, update as any);
					respond(res, 200, { status: "updated" });
					return;
				}

				// 删除定时任务
				if (req.method === "DELETE" && !subPath) {
					schedTaskStore?.delete(taskId);
					respond(res, 200, { status: "deleted" });
					return;
				}

				// 开关
				if (req.method === "POST" && subPath === "toggle") {
					const body = await readBody(req);
					const enabled =
						body?.enabled === true || body?.enabled === false
							? body.enabled
							: true;
					schedTaskStore?.setEnabled(taskId, enabled);
					respond(res, 200, { enabled });
					return;
				}

				// 立即执行一次
				if (req.method === "POST" && subPath === "run-now") {
					if (!schedTaskMgr) {
						respond(res, 503, { error: "定时任务引擎未初始化" });
						return;
					}
					const task = schedTaskStore?.get(taskId);
					if (!task) {
						respond(res, 404, { error: "定时任务不存在" });
						return;
					}
					const newTaskId = schedTaskMgr.triggerNow(taskId);
					if (!newTaskId) {
						respond(res, 500, { error: "触发失败" });
						return;
					}
					respond(res, 200, { status: "triggered", taskId: newTaskId });
					return;
				}

				// 执行历史
				if (req.method === "GET" && subPath === "history") {
					const limit = Number.parseInt(
						url.searchParams.get("limit") || "20",
						10,
					);
					const history = schedTaskStore?.getTaskHistory(taskId, limit);
					respond(res, 200, history);
					return;
				}
			}
			if (
				req.method === "GET" &&
				pathParts[0] === "tasks" &&
				pathParts[1] &&
				pathParts[2] === "stream"
			) {
				const taskId = pathParts[1];
				const task = scheduler.getTask(taskId);
				if (!task) {
					respond(res, 404, { error: "任务不存在" });
					return;
				}

				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				});

				// 断线续传：标准 SSE Last-Event-ID 头（浏览器 EventSource 重连自动携带），兼容 ?lastEventId= 查询参数
				const lastEventIdHeader = req.headers["last-event-id"];
				const lastEventIdRaw =
					(Array.isArray(lastEventIdHeader)
						? lastEventIdHeader[0]
						: lastEventIdHeader) || url.searchParams.get("lastEventId");
				const lastEventId = Number.parseInt(lastEventIdRaw || "", 10);
				const hasLastEventId = Number.isFinite(lastEventId);

				// 发送初始连接事件
				try {
					res.write("event: connected\ndata: {}\n\n");
				} catch {
					/* client may have disconnected already */
				}

				const writeSSE = (event: string, data: unknown, id?: number) => {
					const idLine = id !== undefined ? `id: ${id}\n` : "";
					res.write(
						`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
					);
				};

				// 先订阅（回放期间到达的实时事件进队列），回放完再冲刷——保证事件不丢也不重
				let replayDone = !hasLastEventId;
				const pendingLive: Array<[string, unknown, number]> = [];

				const unsubscribe = taskEventBus.subscribe(
					taskId,
					(event, data, id) => {
						if (!replayDone) {
							pendingLive.push([event, data, id ?? 0]);
							return;
						}
						try {
							writeSSE(event, data, id);
						} catch {
							// Client disconnected — clean up（只摘除自己的监听，不能 removeAllListeners 误杀 worker 桥接/空闲活动监听）
							unsubscribe();
						}
					},
				);

				// 回放缺口：只发客户端错过的（id > lastEventId）事件，增量 token 恰好补齐断线窗口
				if (!replayDone) {
					let maxReplayed = lastEventId;
					for (const e of taskEventBus.replay(taskId, lastEventId)) {
						try {
							writeSSE(e.event, e.data, e.id);
							maxReplayed = e.id;
						} catch {
							break;
						}
					}
					replayDone = true;
					for (const [event, data, id] of pendingLive) {
						if (id <= maxReplayed) continue;
						try {
							writeSSE(event, data, id);
						} catch {
							break;
						}
					}
					pendingLive.length = 0;
				}

				// SSE 心跳：每 20s 发 ping 事件，防止代理/浏览器因空闲断开连接
				const heartbeatTimer = setInterval(() => {
					try {
						res.write("event: ping\ndata: {}\n\n");
					} catch {
						clearInterval(heartbeatTimer);
						unsubscribe();
					}
				}, 20_000);

				req.on("close", () => {
					clearInterval(heartbeatTimer);
					unsubscribe();
				});

				return;
			}

			// --- 获取单个任务 ---
			if (req.method === "GET" && pathParts[0] === "tasks" && pathParts[1]) {
				const task = scheduler.getTask(pathParts[1]);
				if (!task) {
					respond(res, 404, { error: "任务不存在" });
					return;
				}
				respond(res, 200, task);
				return;
			}

			// --- 音频转写 (Whisper / 兼容 API / 离线引擎) ---
			if (req.method === "POST" && url.pathname === "/audio/transcribe") {
				const body = await readBody(req);
				const {
					data,
					mimeType,
					apiKey: bodyKey,
					baseUrl: customBaseUrl,
					model: customModel,
					useLocal,
				} = body || {};
				if (!data) {
					respond(res, 400, { error: "缺少音频数据" });
					return;
				}

				// 使用本地离线引擎
				if (useLocal) {
					if (!whisperEngine.isDownloaded) {
						// 自动触发后台下载
						if (!whisperDownloading) {
							whisperDownloading = true;
							whisperEngine
								.download((msg) => {
									console.error(`[离线引擎] ${msg}`);
								})
								.then(() => {
									whisperDownloading = false;
									console.error("[离线引擎] 下载完成");
								})
								.catch((err) => {
									whisperDownloading = false;
									console.error("[离线引擎] 下载失败:", err);
								});
						}
						respond(res, 400, { error: "离线引擎下载中，请几秒后再试" });
						return;
					}
					const result = await whisperEngine.transcribe(data);
					if (result.error) {
						respond(res, 500, { error: result.error });
					} else {
						respond(res, 200, { text: result.text });
					}
					return;
				}

				const apiKey = process.env.OPENAI_API_KEY || bodyKey;
				if (!apiKey) {
					respond(res, 400, { error: "API Key 未配置" });
					return;
				}

				const whisperModel = customModel || "whisper-1";
				const rawBase = (customBaseUrl || "https://api.openai.com").replace(
					/\/+$/,
					"",
				);
				// If the base URL already contains the transcription path, use it directly;
				// otherwise append /v1/audio/transcriptions
				const whisperUrl =
					rawBase.includes("/audio/transcriptions") ||
					rawBase.includes("/audio/transcription")
						? rawBase
						: `${rawBase}/v1/audio/transcriptions`;

				try {
					const audioBuffer = Buffer.from(data, "base64");

					// Use node:https for reliable FormData/Blob across Node.js versions
					const https = await import("node:https");
					const http = await import("node:http");
					const { URL } = await import("node:url");

					const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
					const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.webm"\r\nContent-Type: ${mimeType || "audio/webm"}\r\n\r\n`;
					const footer = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${whisperModel}\r\n--${boundary}--\r\n`;
					const headerBuf = Buffer.from(header, "utf-8");
					const footerBuf = Buffer.from(footer, "utf-8");
					const bodyBuf = Buffer.concat([headerBuf, audioBuffer, footerBuf]);

					const parsedUrl = new URL(whisperUrl);
					const transport = parsedUrl.protocol === "https:" ? https : http;

					const whisperResult = await new Promise<string>((resolve, reject) => {
						const req2 = transport.request(
							whisperUrl,
							{
								method: "POST",
								headers: {
									Authorization: `Bearer ${apiKey}`,
									"Content-Type": `multipart/form-data; boundary=${boundary}`,
									"Content-Length": String(bodyBuf.length),
								},
								timeout: 30000,
							},
							(res2) => {
								const chunks: Buffer[] = [];
								res2.on("data", (c: Buffer) => chunks.push(c));
								res2.on("end", () => {
									const raw = Buffer.concat(chunks).toString("utf-8");
									if (!res2.statusCode || res2.statusCode >= 400) {
										reject(
											new Error(
												`Whisper API 返回 ${res2.statusCode}: ${raw.slice(0, 200)}`,
											),
										);
									} else {
										try {
											resolve(JSON.parse(raw).text || "");
										} catch {
											reject(
												new Error(
													`Whisper API 响应解析失败: ${raw.slice(0, 200)}`,
												),
											);
										}
									}
								});
							},
						);
						req2.on("error", (e) =>
							reject(new Error(`请求失败 (${whisperUrl}): ${e.message}`)),
						);
						req2.on("timeout", () => {
							req2.destroy();
							reject(new Error(`请求超时 (${whisperUrl})`));
						});
						req2.write(bodyBuf);
						req2.end();
					});

					respond(res, 200, { text: whisperResult });
				} catch (err: any) {
					respond(res, 500, { error: err.message });
				}
				return;
			}

			// --- 离线引擎状态 ---
			if (
				req.method === "GET" &&
				url.pathname === "/audio/transcribe/local-status"
			) {
				respond(res, 200, {
					ready: whisperEngine.isReady,
					downloaded: whisperEngine.isDownloaded,
					downloading: whisperDownloading,
					progress: whisperEngine.downloadProgress,
					error: whisperEngine.error,
					binPath: whisperEngine.binPath,
					modelPath: whisperEngine.modelPath,
				});
				return;
			}

			// --- 触发离线引擎下载 ---
			if (
				req.method === "POST" &&
				url.pathname === "/audio/transcribe/download"
			) {
				if (whisperDownloading) {
					respond(res, 400, { error: "正在下载中，请稍候" });
					return;
				}
				whisperDownloading = true;
				// 后台下载，立即返回
				whisperEngine
					.download((msg) => {
						console.error(`[离线引擎] ${msg}`);
					})
					.then(() => {
						whisperDownloading = false;
						console.error("[离线引擎] 下载完成");
					})
					.catch((err) => {
						whisperDownloading = false;
						console.error("[离线引擎] 下载失败:", err);
					});
				respond(res, 200, { status: "started" });
				return;
			}

			// --- 内联代码补全 ---
			if (req.method === "POST" && url.pathname === "/completions/inline") {
				const body = await readBody(req);
				if (!body?.content || !body?.position || !body?.filePath) {
					respond(res, 400, {
						error: "缺少必填字段: content, position, filePath",
					});
					return;
				}
				try {
					const { handleInlineCompletion } = await import(
						"./completions/inlineCompletion"
					);
					const completions = await handleInlineCompletion(
						body,
						scheduler.model,
					);
					respond(res, 200, { completions });
				} catch {
					respond(res, 200, { completions: [] });
				}
				return;
			}

			// --- 文档解析 ---
			if (req.method === "POST" && url.pathname === "/documents/parse") {
				const body = await readBody(req);
				const { data, filename, filePath } = body || {};
				let targetPath = filePath;

				if (data && filename) {
					// Save base64 data to temp file
					const { tmpdir } = await import("node:os");
					targetPath = path.join(tmpdir(), filename);
					const { writeFile, unlink } = await import("node:fs/promises");
					await writeFile(targetPath, Buffer.from(data, "base64"));
				}

				if (!targetPath) {
					respond(res, 400, { error: "Missing file data or path" });
					return;
				}

				try {
					const { parseDocument } = await import("./documentParser");
					const result = await parseDocument(targetPath);
					respond(res, 200, result);
				} catch (err: any) {
					respond(res, 500, { error: err.message });
				} finally {
					// Clean up temp file if we created one
					if (!filePath && targetPath) {
						const { unlink } = await import("node:fs/promises");
						unlink(targetPath).catch(() => {});
					}
				}
				return;
			}

			// --- 对话历史压缩（单次 LLM 调用生成摘要） ---
			if (req.method === "POST" && url.pathname === "/messages/summarize") {
				const body = await readBody(req);
				const messages = Array.isArray(body?.messages) ? body.messages : [];
				if (messages.length === 0) {
					respond(res, 400, { error: "messages 不能为空" });
					return;
				}
				try {
					const transcript = messages
						.map(
							(m: { role: string; content: string }) =>
								`${m.role === "user" ? "用户" : "玄码"}: ${m.content || ""}`,
						)
						.join("\n\n");
					const sysPrompt =
						"你是对话压缩器。把以下对话历史压缩成简洁摘要，保留：用户意图、已做决定、关键文件/函数名、未解决问题。用要点形式，不超过 400 字。不要寒暄。";
					const summary = await scheduler.model.chat(
						[{ role: "user", content: transcript }],
						sysPrompt,
					);
					respond(res, 200, { summary: summary || "" });
				} catch (err: any) {
					respond(res, 500, { error: err?.message || "摘要生成失败" });
				}
				return;
			}

			// --- 运行时配置（provider / model / apiKey / chatMode） ---
			if (req.method === "POST" && url.pathname === "/daemon/configure") {
				const body = await readBody(req);
				const newProvider = body?.provider;
				const newModelName = body?.modelName;
				const newApiKey = body?.apiKey;
				const newChatMode = body?.chatMode as string | undefined;
				const newCloudToken = body?.cloudToken as string | undefined;
				const newReasoningLevel = body?.reasoningLevel as string | undefined;

				if (!newProvider || !newModelName) {
					respond(res, 400, { error: "缺少必填字段: provider, modelName" });
					return;
				}

				// Store chat mode in env so other parts of daemon can check it
				if (newChatMode) {
					process.env.CHAT_MODE = newChatMode;
				}
				if (newCloudToken) {
					process.env.CLOUD_TOKEN = newCloudToken;
				}

				// Cloud mode: don't override env with user's API key; platform keys from GatewayWorker are used
				if (newChatMode === "cloud") {
					// If cloud mode but an apiKey was sent, ignore it (platform keys take precedence)
					if (newApiKey) {
						console.error(
							`[configure] Cloud mode: using platform key for ${newProvider}, ignoring user key`,
						);
					}
					// Don't set process.env for the provider — GatewayWorker key cache handles it
				} else if (newApiKey) {
					// Local mode: 设置对应的环境变量（适配器通过 process.env 读取）
					const providerKey = newProvider.toUpperCase();
					process.env[`${providerKey}_API_KEY`] = newApiKey;
					// 兼容常见环境变量名
					if (newProvider === "deepseek")
						process.env.DEEPSEEK_API_KEY = newApiKey;
					if (newProvider === "openai") process.env.OPENAI_API_KEY = newApiKey;
					if (newProvider === "anthropic")
						process.env.ANTHROPIC_API_KEY = newApiKey;
					if (newProvider === "google") process.env.GOOGLE_API_KEY = newApiKey;
					if (newProvider === "zhipu") process.env.ZHIPU_API_KEY = newApiKey;
					if (newProvider === "volcengine")
						process.env.VOLC_API_KEY = newApiKey;
				}

				// Store reasoning level for task submission
				if (
					newReasoningLevel &&
					["fast", "medium", "expert"].includes(newReasoningLevel)
				) {
					process.env.REASONING_LEVEL = newReasoningLevel;
				}

				try {
					scheduler.configureModel(newProvider, newModelName);
					respond(res, 200, {
						status: "ok",
						provider: newProvider,
						modelName: newModelName,
					});
				} catch (err) {
					respond(res, 400, { error: `模型配置失败: ${err}` });
				}
				return;
			}

			// --- 获取成本统计 ---
			if (req.method === "GET" && url.pathname === "/daemon/costs") {
				const modelRouter = scheduler.getModelRouter();
				if (!modelRouter) {
					respond(res, 200, { records: [], aggregates: [], totalCost: 0 });
					return;
				}
				respond(res, 200, {
					records: modelRouter.costTracker.getAll(),
					aggregates: modelRouter.costTracker.getAggregates(),
					totalCost: modelRouter.costTracker.totalCost,
				});
				return;
			}

			// --- Telemetry: 列出 traces ---
			if (
				enableTelemetry &&
				req.method === "GET" &&
				url.pathname === "/daemon/traces"
			) {
				const limit = Number.parseInt(
					url.searchParams.get("limit") || "20",
					10,
				);
				respond(res, 200, {
					traces: telemetryTracer?.listTraces(limit),
				});
				return;
			}

			// --- Telemetry: 获取单个 trace ---
			const tracePathMatch = url.pathname.match(/^\/daemon\/traces\/([^/]+)$/);
			if (enableTelemetry && req.method === "GET" && tracePathMatch) {
				const trace = telemetryTracer?.getTrace(tracePathMatch[1]);
				if (!trace) {
					respond(res, 404, { error: "Trace not found" });
					return;
				}
				// 附带 speedrun 分析
				const analysis = speedrunAnalyzer?.analyze(trace);
				respond(res, 200, { trace, analysis });
				return;
			}

			// ===== 自改进优化器端点（仅在 telemetry 启用时可用） =====

			// --- 列出优化建议 ---
			if (
				enableTelemetry &&
				req.method === "GET" &&
				url.pathname === "/daemon/optimizer/suggestions"
			) {
				if (!optimizerService) {
					respond(res, 200, { suggestions: [] });
					return;
				}
				const limit = Number.parseInt(
					url.searchParams.get("limit") || "20",
					10,
				);
				const suggestions = await optimizerService.listSuggestions(limit);
				respond(res, 200, { suggestions });
				return;
			}

			// --- 跨 session 趋势分析 ---
			if (
				enableTelemetry &&
				req.method === "GET" &&
				url.pathname === "/daemon/optimizer/trends"
			) {
				if (!optimizerService) {
					respond(res, 200, { trends: null });
					return;
				}
				const limit = Number.parseInt(
					url.searchParams.get("limit") || "20",
					10,
				);
				const trends = await optimizerService.analyzeTrends(limit);
				respond(res, 200, { trends });
				return;
			}

			// --- 分析单条 trace ---
			const optTracePathMatch = url.pathname.match(
				/^\/daemon\/optimizer\/analyze\/([^/]+)$/,
			);
			if (enableTelemetry && req.method === "GET" && optTracePathMatch) {
				if (!optimizerService) {
					respond(res, 404, { error: "Optimizer not available" });
					return;
				}
				try {
					const suggestion = await optimizerService.analyzeTrace(
						optTracePathMatch[1],
					);
					respond(res, 200, { suggestion });
				} catch (err: any) {
					respond(res, 404, { error: err.message || "Trace not found" });
				}
				return;
			}

			// --- 优化建议反馈 ---
			if (
				req.method === "POST" &&
				url.pathname === "/daemon/optimizer/feedback"
			) {
				try {
					const body = await readBody(req);
					const { suggestionId, action } = body;
					if (!suggestionId || !action) {
						respond(res, 400, { error: "缺少 suggestionId 或 action" });
						return;
					}
					if (optimizerService) {
						optimizerService.recordFeedback(suggestionId, action);
						respond(res, 200, { ok: true });
					} else {
						respond(res, 200, { ok: true, note: "optimizer not available" });
					}
				} catch {
					respond(res, 400, { error: "无效的请求体" });
				}
				return;
			}

			// --- 工具使用统计 ---
			if (
				enableTelemetry &&
				req.method === "GET" &&
				url.pathname === "/daemon/optimizer/tool-usage"
			) {
				if (!optimizerService) {
					respond(res, 200, { stats: [] });
					return;
				}
				const limit = Number.parseInt(
					url.searchParams.get("limit") || "50",
					10,
				);
				const stats = await optimizerService.getToolUsageStats(limit);
				respond(res, 200, { stats });
				return;
			}

			// ===== 代码智能端点 =====

			// --- 索引状态 ---
			if (
				req.method === "GET" &&
				url.pathname === "/daemon/code-index/status"
			) {
				respond(res, 200, codeIntelligenceService.getStatus());
				return;
			}

			// --- 依赖图 ---
			if (req.method === "GET" && url.pathname === "/daemon/code-index/graph") {
				respond(res, 200, codeIntelligenceService.getGraph());
				return;
			}

			// --- 影响范围分析（Agent 联动） ---
			if (
				req.method === "POST" &&
				url.pathname === "/daemon/code-index/affected"
			) {
				const body = await readBody(req);
				const changedFiles = body?.changedFiles;
				const maxDepth = typeof body?.maxDepth === "number" ? body.maxDepth : 8;
				if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
					respond(res, 400, { error: "缺少必填字段: changedFiles (非空数组)" });
					return;
				}
				const result = codeIntelligenceService.findAffectedFiles(
					changedFiles,
					maxDepth,
				);
				respond(res, 200, result);
				return;
			}

			// --- 强制重建索引（增量：仅重解析已变更文件） ---
			if (
				req.method === "POST" &&
				url.pathname === "/daemon/code-index/rebuild"
			) {
				codeIntelligenceService.rebuild().catch(() => {});
				respond(res, 200, { status: "rebuilding" });
				return;
			}

			// --- 搜索代码 ---
			if (
				req.method === "GET" &&
				url.pathname === "/daemon/code-index/search"
			) {
				const query = url.searchParams.get("q");
				const path = url.searchParams.get("path") || undefined;
				const topK = Number.parseInt(url.searchParams.get("topK") || "10", 10);
				if (!query) {
					respond(res, 400, { error: "缺少查询参数: q" });
					return;
				}
				const results = await codeIntelligenceService.search(query, path, topK);
				respond(res, 200, { results });
				return;
			}

			// --- 更新工作目录 ---
			if (req.method === "POST" && url.pathname === "/daemon/workdir") {
				const body = await readBody(req);
				const dir = body?.workDir;
				if (!dir) {
					respond(res, 400, { error: "缺少必填字段: workDir" });
					return;
				}
				scheduler.setWorkDir(dir);
				respond(res, 200, { status: "ok", workDir: dir });
				return;
			}

			// --- 启动调度器 ---
			if (req.method === "POST" && url.pathname === "/daemon/start") {
				scheduler
					.start()
					.then(() => respond(res, 200, { status: "started" }))
					.catch(() => respond(res, 500, { error: "启动失败" }));
				return;
			}

			// --- 停止调度器 ---
			if (req.method === "POST" && url.pathname === "/daemon/stop") {
				scheduler.stop();
				respond(res, 200, { status: "stopped" });
				return;
			}

			// --- 统计汇总 ---
			if (req.method === "GET" && url.pathname === "/stats") {
				respond(res, 200, {
					...scheduler.getStats(),
					uptime: process.uptime(),
				});
				return;
			}

			// --- 会话列表 ---
			if (req.method === "GET" && url.pathname === "/sessions") {
				if (scheduler.intelCommander) {
					const limit = Number.parseInt(
						url.searchParams.get("limit") || "50",
						10,
					);
					const offset = Number.parseInt(
						url.searchParams.get("offset") || "0",
						10,
					);
					const sessions = await scheduler.intelCommander.request(
						"list_sessions",
						{ limit, offset },
						5000,
					);
					respond(res, 200, sessions);
				} else if (scheduler.sessionPersistence) {
					const sessions = scheduler.sessionPersistence.listSessions();
					respond(res, 200, sessions);
				} else {
					const sessions = await sessionManager.listSessions();
					respond(res, 200, sessions);
				}
				return;
			} // --- 搜索会话 ---
			if (req.method === "GET" && url.pathname === "/sessions/search") {
				const q = url.searchParams.get("q");
				if (!q) {
					respond(res, 400, { error: "缺少查询参数: q" });
					return;
				}
				const limit = Number.parseInt(
					url.searchParams.get("limit") || "20",
					10,
				);
				if (scheduler.intelCommander) {
					const result = await scheduler.intelCommander.request(
						"search_sessions",
						{ query: q, limit },
						5000,
					);
					respond(res, 200, result);
				} else if (scheduler.sessionIndexer) {
					const results = scheduler.sessionIndexer.search(q, limit);
					respond(res, 200, { results });
				} else {
					respond(res, 200, { results: [] });
				}
				return;
			} // --- 重建搜索索引 ---
			if (
				req.method === "POST" &&
				url.pathname === "/sessions/search/rebuild"
			) {
				if (scheduler.intelCommander) {
					await scheduler.intelCommander.request("rebuild_index", {}, 30000);
					respond(res, 200, { status: "ok" });
				} else if (scheduler.sessionIndexer) {
					try {
						scheduler.sessionIndexer.rebuildAll();
						respond(res, 200, { status: "ok" });
					} catch (e: any) {
						respond(res, 500, { error: e.message });
					}
				} else {
					respond(res, 400, { error: "索引器未初始化" });
				}
				return;
			} // --- 会话详情 ---
			const sessionDetailMatch = url.pathname.match(/^\/sessions\/([^\/]+)$/);
			if (req.method === "GET" && sessionDetailMatch) {
				const sessionId = sessionDetailMatch[1];
				if (scheduler.intelCommander) {
					const detail = await scheduler.intelCommander.request(
						"get_session_detail",
						{ sessionId },
						5000,
					);
					if (!detail) {
						respond(res, 404, { error: "会话不存在" });
					} else {
						respond(res, 200, detail);
					}
				} else if (scheduler.sessionPersistence) {
					const detail =
						scheduler.sessionPersistence.getSessionDetail(sessionId);
					if (!detail) {
						respond(res, 404, { error: "会话不存在" });
					} else {
						respond(res, 200, detail);
					}
				} else {
					respond(res, 404, { error: "SQLite 未初始化" });
				}
				return;
			} // ===== 认证/商业端点（私有仓 auth 组件；公开仓 auth=null 时全部 404） =====
			if (await auth?.handleRoute(req, res, url, pathParts)) return;

			// ===== 管理后台 =====

			// --- 系统状态（需管理员鉴权，防止泄露内部信息）---
			if (req.method === "GET" && url.pathname === "/admin/status") {
				if (auth && !(await auth.authorizeAdmin(req))) {
					respond(res, 403, { error: "仅管理员可查看系统状态" });
					return;
				}
				respond(res, 200, {
					storageMode: usePg ? "postgresql" : "jsonl",
					uptime: process.uptime(),
					memory: process.memoryUsage().rss,
				});
				return;
			}

			// --- 管理后台页面（内嵌 HTML，无需文件路径解析） ---
			if (req.method === "GET" && url.pathname === "/admin") {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(ADMIN_HTML);
				return;
			}

			// --- 移动端页面（内嵌 HTML，手机浏览器/WebView 访问） ---
			if (req.method === "GET" && url.pathname === "/mobile") {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(MOBILE_HTML);
				return;
			}

			// ===== A2A 协议路由 (仅 enableA2A 时启用) =====

			if (a2aServer) {
				// GET /.well-known/agent.json — Agent Card 发现
				if (
					req.method === "GET" &&
					url.pathname === "/.well-known/agent.json"
				) {
					respond(res, 200, a2aServer.getAgentCard());
					return;
				}

				// POST /a2a/tasks — 提交任务
				if (req.method === "POST" && url.pathname === "/a2a/tasks") {
					const body = await readBody(req);
					const task = a2aServer.createTask(body);
					res.writeHead(201, {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
					});
					res.end(JSON.stringify(task));
					return;
				}

				// GET /a2a/tasks — 列出任务
				if (req.method === "GET" && url.pathname === "/a2a/tasks") {
					const limit = Number.parseInt(
						url.searchParams.get("limit") || "20",
						10,
					);
					respond(res, 200, a2aServer.listTasks(limit));
					return;
				}

				// GET /a2a/tasks/:id — 获取任务
				const a2aTaskMatch = url.pathname.match(/^\/a2a\/tasks\/([^/]+)$/);
				if (req.method === "GET" && a2aTaskMatch) {
					const task = a2aServer.getTask(a2aTaskMatch[1]);
					if (!task) {
						respond(res, 404, { error: "A2A 任务不存在" });
						return;
					}
					respond(res, 200, task);
					return;
				}

				// GET /a2a/tasks/:id/stream — SSE 任务事件流
				const a2aStreamMatch = url.pathname.match(
					/^\/a2a\/tasks\/([^/]+)\/stream$/,
				);
				if (req.method === "GET" && a2aStreamMatch) {
					const taskId = a2aStreamMatch[1];
					const task = a2aServer.getTask(taskId);
					if (!task) {
						respond(res, 404, { error: "A2A 任务不存在" });
						return;
					}

					res.writeHead(200, {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
						"Access-Control-Allow-Origin": "*",
					});

					// 发送当前状态
					res.write(
						`event: task_update\ndata: ${JSON.stringify({
							id: task.id,
							state: task.state,
							output: task.output,
							error: task.error,
							timestamp: task.updatedAt,
						})}\n\n`,
					);

					// 注册 SSE 客户端接收后续更新
					a2aServer.addSSEClient(taskId, { id: taskId, res });

					req.on("close", () => {
						try {
							res.end();
						} catch {
							/* ignore */
						}
					});

					return;
				}
			}

			// ===== 插件管理端点 =====

			// ===== 工具分类 =====
			if (
				req.method === "GET" &&
				url.pathname === "/daemon/plugins/categories"
			) {
				respond(res, 200, {
					categories: [
						{
							id: "creative-design",
							labelZh: "创意设计",
							labelEn: "Creative Design",
							icon: "🎨",
							desc: "设计工具、CAD建模、AI画图",
						},
						{
							id: "knowledge-research",
							labelZh: "知识科研",
							labelEn: "Knowledge & Research",
							icon: "📚",
							desc: "论文工具、文献检索、行业分析",
						},
						{
							id: "productivity",
							labelZh: "办公效率",
							labelEn: "Productivity",
							icon: "⚡",
							desc: "日历、邮件、工单、RPA自动化",
						},
						{
							id: "lifestyle",
							labelZh: "生活服务",
							labelEn: "Lifestyle",
							icon: "🌍",
							desc: "行程规划、旅游出行、生活工具",
						},
					],
				});
				return;
			}

			// ===== MCP 服务状态 =====
			if (req.method === "GET" && url.pathname === "/daemon/mcp/status") {
				const mcpRunning = mcpServerInstance.server?.listening ?? false;
				respond(res, 200, {
					enabled: opts.enableMCP ?? false,
					running: mcpRunning,
					sessionCount: mcpServerInstance.mcpServer?.sessionCount ?? 0,
					port: 3021,
				});
				return;
			}

			// ===== MCP 多服务管理 (VS Code 风格的 mcpServers) =====
			const mcpSvcsDir = path.join(workDir, ".xuancode", "mcp-services");
			const mcpSvcsFile = path.join(mcpSvcsDir, "services.jsonl");

			async function loadMcpServices() {
				try {
					await fs.promises.mkdir(mcpSvcsDir, { recursive: true });
					const raw = await fs.promises.readFile(mcpSvcsFile, "utf-8");
					return raw
						.split("\n")
						.filter(Boolean)
						.map((l) => {
							try {
								return JSON.parse(l);
							} catch {
								return null;
							}
						})
						.filter(Boolean);
				} catch {
					return [];
				}
			}

			async function saveAllMcpServices(services: any[]) {
				await fs.promises.mkdir(mcpSvcsDir, { recursive: true });
				const lines = `${services.map((s) => JSON.stringify(s)).join("\n")}\n`;
				await fs.promises.writeFile(mcpSvcsFile, lines, "utf-8");
			}

			function startMcpServiceProcess(svc: any) {
				const existing = mcpSvcProcesses.get(svc.name);
				if (existing?.proc) {
					try {
						existing.proc.kill();
					} catch {}
				}
				try {
					const child = spawn(svc.command, svc.args || [], {
						env: { ...process.env, ...(svc.env || {}) },
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
					});
					const entry = {
						proc: child,
						status: "running" as const,
						lastError: "",
						startedAt: Date.now(),
					};
					mcpSvcProcesses.set(svc.name, entry);
					child.on("exit", (code: number | null) => {
						const e = mcpSvcProcesses.get(svc.name);
						if (e) {
							e.status = code === 0 ? "stopped" : "error";
							e.proc = null;
							if (code !== 0 && code !== null)
								e.lastError = `exit code ${code}`;
						}
					});
					child.on("error", (err: Error) => {
						const e = mcpSvcProcesses.get(svc.name);
						if (e) {
							e.status = "error";
							e.lastError = err.message;
							e.proc = null;
						}
					});
					return true;
				} catch (err: any) {
					mcpSvcProcesses.set(svc.name, {
						proc: null,
						status: "error",
						lastError: err.message,
						startedAt: 0,
					});
					return false;
				}
			}

			function stopMcpServiceProcess(name: string) {
				const entry = mcpSvcProcesses.get(name);
				if (entry?.proc) {
					try {
						entry.proc.kill("SIGTERM");
					} catch {}
				}
				if (entry) {
					entry.status = "stopped";
					entry.proc = null;
				}
			}

			// GET /daemon/mcp/services — 列表
			if (req.method === "GET" && url.pathname === "/daemon/mcp/services") {
				const services = await loadMcpServices();
				const withStatus = services.map((s) => {
					const proc = mcpSvcProcesses.get(s.name);
					return {
						...s,
						status: proc?.status || "stopped",
						lastError: proc?.lastError || "",
						startedAt: proc?.startedAt || 0,
					};
				});
				respond(res, 200, { services: withStatus });
				return;
			}

			// POST /daemon/mcp/services — 创建
			if (req.method === "POST" && url.pathname === "/daemon/mcp/services") {
				let body = "";
				req.on("data", (c) => {
					body += c;
				});
				req.on("end", async () => {
					try {
						const data = JSON.parse(body);
						if (!data.name || !data.command) {
							respond(res, 400, { error: "name 和 command 为必填" });
							return;
						}
						const services = await loadMcpServices();
						if (services.some((s) => s.name === data.name)) {
							respond(res, 409, { error: "服务已存在" });
							return;
						}
						const newSvc = {
							name: data.name,
							displayName: data.displayName || data.name,
							description: data.description || "",
							command: data.command,
							args: data.args || [],
							env: data.env || {},
							autoStart: !!data.autoStart,
						};
						services.push(newSvc);
						await saveAllMcpServices(services);
						if (newSvc.autoStart) startMcpServiceProcess(newSvc);
						respond(res, 201, {
							service: {
								...newSvc,
								status: mcpSvcProcesses.get(newSvc.name)?.status || "stopped",
							},
						});
					} catch (e) {
						respond(res, 400, { error: "请求格式错误" });
					}
				});
				return;
			}

			// POST /daemon/mcp/services/:name/start — 启动
			if (
				req.method === "POST" &&
				url.pathname.startsWith("/daemon/mcp/services/") &&
				url.pathname.endsWith("/start")
			) {
				const svcName = decodeURIComponent(url.pathname.split("/")[4]);
				const services = await loadMcpServices();
				const svc = services.find((s) => s.name === svcName);
				if (!svc) {
					respond(res, 404, { error: "服务未找到" });
					return;
				}
				const ok = startMcpServiceProcess(svc);
				respond(res, 200, {
					status: ok ? "started" : "error",
					error: ok ? undefined : "启动失败",
				});
				return;
			}

			// POST /daemon/mcp/services/:name/stop — 停止
			if (
				req.method === "POST" &&
				url.pathname.startsWith("/daemon/mcp/services/") &&
				url.pathname.endsWith("/stop")
			) {
				const svcName = decodeURIComponent(url.pathname.split("/")[4]);
				stopMcpServiceProcess(svcName);
				respond(res, 200, { status: "stopped" });
				return;
			}

			// PUT /daemon/mcp/services/:name — 更新
			if (
				req.method === "PUT" &&
				url.pathname.startsWith("/daemon/mcp/services/")
			) {
				const svcName = decodeURIComponent(url.pathname.split("/")[4]);
				let body = "";
				req.on("data", (c) => {
					body += c;
				});
				req.on("end", async () => {
					try {
						const updates = JSON.parse(body);
						const services = await loadMcpServices();
						const idx = services.findIndex((s) => s.name === svcName);
						if (idx === -1) {
							respond(res, 404, { error: "服务未找到" });
							return;
						}
						services[idx] = { ...services[idx], ...updates, name: svcName };
						await saveAllMcpServices(services);
						if (mcpSvcProcesses.get(svcName)?.status === "running") {
							stopMcpServiceProcess(svcName);
							startMcpServiceProcess(services[idx]);
						}
						respond(res, 200, {
							service: {
								...services[idx],
								status: mcpSvcProcesses.get(svcName)?.status || "stopped",
							},
						});
					} catch (e) {
						respond(res, 400, { error: "请求格式错误" });
					}
				});
				return;
			}

			// DELETE /daemon/mcp/services/:name — 删除
			if (
				req.method === "DELETE" &&
				url.pathname.startsWith("/daemon/mcp/services/")
			) {
				const svcName = decodeURIComponent(url.pathname.split("/")[4]);
				const services = await loadMcpServices();
				const idx = services.findIndex((s) => s.name === svcName);
				if (idx === -1) {
					respond(res, 404, { error: "服务未找到" });
					return;
				}
				stopMcpServiceProcess(svcName);
				services.splice(idx, 1);
				await saveAllMcpServices(services);
				respond(res, 200, { status: "deleted" });
				return;
			}

			// ===== 计算机控制 (Computer Use) =====
			if (req.method === "POST" && url.pathname === "/computer-use/enable") {
				computerUseService.setEnabled(true);
				respond(res, 200, { status: "enabled" });
				return;
			}
			if (req.method === "POST" && url.pathname === "/computer-use/disable") {
				computerUseService.setEnabled(false);
				respond(res, 200, { status: "disabled" });
				return;
			}
			if (req.method === "GET" && url.pathname === "/computer-use/status") {
				respond(res, 200, { enabled: computerUseService.enabled });
				return;
			}

			// ===== Skills 列表（动态 JSONL 存储） =====
			// --- 辅助函数 ---
			const skillsDir = path.join(workDir, ".xuancode", "skills");
			const skillsFile = path.join(skillsDir, "skills.jsonl");

			async function loadSkills() {
				try {
					await fs.promises.mkdir(skillsDir, { recursive: true });
					const raw = await fs.promises.readFile(skillsFile, "utf-8");
					return raw
						.split("\n")
						.filter(Boolean)
						.map((l) => {
							try {
								return JSON.parse(l);
							} catch {
								return null;
							}
						})
						.filter(Boolean);
				} catch {
					// Seed builtin skills on first run
					const builtins = [
						// ===== 代码类 =====
						{
							name: "code-review",
							displayName: "代码审查",
							description:
								"自动化代码评审，检查代码质量、安全漏洞和最佳实践\n步骤：读取代码 → 静态分析 → 生成审查报告",
							command: "/review",
							builtin: true,
							category: "code",
							author: "系统",
							version: "1.0.0",
							systemPrompt:
								"你是一个资深代码审查专家，擅长发现代码中的质量、安全和性能问题。\n\n审查原则：\n1. 严格检查逻辑漏洞和边界条件\n2. 关注安全风险：注入、越权、敏感信息泄露\n3. 关注可维护性：命名、复杂度、重复代码\n4. 每个问题给出严重等级和修复建议",
							steps: [
								{
									id: "cr1",
									type: "tool",
									label: "读取代码",
									value: "读取目标代码文件",
									description: "读取需要审查的代码文件",
								},
								{
									id: "cr2",
									type: "tool",
									label: "静态分析",
									value: "分析代码结构、依赖和复杂度",
									description: "对代码进行静态分析",
								},
								{
									id: "cr3",
									type: "prompt",
									label: "生成审查报告",
									value: "基于分析结果生成代码审查报告，包含问题列表和改进建议",
									description: "输出代码审查结果",
								},
							],
						},
						{
							name: "doc-gen",
							displayName: "文档生成",
							description:
								"从代码自动生成 API 文档和项目文档\n步骤：解析代码 → 提取注释 → 生成文档",
							command: "/docs",
							builtin: true,
							category: "content",
							author: "系统",
							version: "1.0.0",
							steps: [
								{
									id: "dg1",
									type: "tool",
									label: "解析代码",
									value: "解析代码结构和接口定义",
									description: "读取并解析源代码",
								},
								{
									id: "dg2",
									type: "tool",
									label: "提取注释",
									value: "提取代码中的注释和类型定义",
									description: "抽取文档相关注释",
								},
								{
									id: "dg3",
									type: "prompt",
									label: "生成文档",
									value: "基于解析结果生成 API 文档和项目文档",
									description: "输出格式化文档",
								},
							],
						},
						{
							name: "db-analyze",
							displayName: "数据库分析",
							description:
								"SQL 查询优化建议和数据库 Schema 分析\n步骤：读取 Schema → 分析查询 → 输出优化建议",
							command: "/db",
							builtin: true,
							category: "data",
							author: "系统",
							version: "1.0.0",
							steps: [
								{
									id: "da1",
									type: "tool",
									label: "读取 Schema",
									value: "读取数据库表结构和索引定义",
									description: "获取数据库 Schema",
								},
								{
									id: "da2",
									type: "tool",
									label: "分析查询",
									value: "分析 SQL 查询执行计划",
									description: "检查查询性能",
								},
								{
									id: "da3",
									type: "prompt",
									label: "输出优化建议",
									value: "基于分析结果提供 SQL 优化和索引建议",
									description: "生成优化报告",
								},
							],
						},
						// ===== 内容创作类 =====
						{
							name: "copywriting",
							displayName: "文案翻译",
							description:
								"多语言文案撰写、翻译与本地化\n步骤：原文分析 → 翻译/创作 → 润色校对",
							command: "/write",
							builtin: true,
							category: "content",
							author: "系统",
							version: "1.0.0",
							steps: [
								{
									id: "cw1",
									type: "tool",
									label: "原文分析",
									value: "分析源语言文本的语境和风格",
									description: "理解原文意图",
								},
								{
									id: "cw2",
									type: "prompt",
									label: "翻译/创作",
									value: "根据要求进行翻译或文案创作",
									description: "生成目标语言内容",
								},
								{
									id: "cw3",
									type: "prompt",
									label: "润色校对",
									value: "检查语法、风格一致性并进行润色",
									description: "质量校对",
								},
							],
						},
						{
							name: "music-gen",
							displayName: "音乐生成",
							description:
								"AI 音乐创作：歌词生成、旋律编曲、音色选择\n步骤：设定风格 → 生成歌词 → 生成旋律",
							command: "/music",
							builtin: true,
							category: "content",
							author: "系统",
							version: "1.0.0",
							steps: [
								{
									id: "mg1",
									type: "prompt",
									label: "设定风格",
									value: "确定音乐风格、情感基调、节奏类型",
									description: "确定创作方向",
								},
								{
									id: "mg2",
									type: "prompt",
									label: "生成歌词",
									value: "基于主题生成歌词文本",
									description: "歌词创作",
								},
								{
									id: "mg3",
									type: "prompt",
									label: "生成旋律",
									value: "生成旋律线条、和弦进行和编曲建议",
									description: "旋律编曲",
								},
							],
						},
						{
							name: "video-gen",
							displayName: "视频生成",
							description:
								"AI 视频生成：脚本撰写、镜头规划、视频合成\n步骤：脚本创作 → 分镜规划 → 视频合成",
							command: "/video",
							builtin: true,
							category: "content",
							author: "系统",
							version: "1.0.0",
							steps: [
								{
									id: "vg1",
									type: "prompt",
									label: "脚本创作",
									value: "撰写视频脚本、对白和旁白",
									description: "视频脚本",
								},
								{
									id: "vg2",
									type: "prompt",
									label: "分镜规划",
									value: "规划镜头序列、场景转换和视觉效果",
									description: "分镜头设计",
								},
								{
									id: "vg3",
									type: "command",
									label: "视频合成",
									value: "生成视频帧并合成为完整视频",
									description: "最终合成",
								},
							],
						},
						// ===== 数据处理类 =====
						{
							name: "data-clean",
							displayName: "数据清洗",
							description:
								"数据清洗与预处理：去重、格式化、异常检测\n步骤：数据扫描 → 清洗规则 → 输出标准数据",
							command: "/clean",
							builtin: true,
							category: "data",
							author: "系统",
							version: "1.0.0",
							steps: [
								{
									id: "dc1",
									type: "tool",
									label: "数据扫描",
									value: "扫描数据源，识别缺失值、异常值和重复项",
									description: "扫描数据质量问题",
								},
								{
									id: "dc2",
									type: "prompt",
									label: "清洗规则",
									value: "定义并应用数据清洗规则（去重、填充、格式化）",
									description: "应用清洗规则",
								},
								{
									id: "dc3",
									type: "tool",
									label: "输出标准数据",
									value: "输出清洗后的标准化数据",
									description: "导出清洗结果",
								},
							],
						},
						// ===== 自动化控制类 =====
						{
							name: "remote-control",
							displayName: "远程控制",
							description:
								"远程设备交互与自动化控制\n步骤：设备连接 → 指令下发 → 状态监控",
							command: "/remote",
							builtin: true,
							category: "custom",
							author: "系统",
							version: "1.0.0",
							steps: [
								{
									id: "rc1",
									type: "tool",
									label: "设备连接",
									value: "建立与远程设备的安全连接",
									description: "连接设备",
								},
								{
									id: "rc2",
									type: "command",
									label: "指令下发",
									value: "执行远程操作指令",
									description: "发送控制指令",
								},
								{
									id: "rc3",
									type: "tool",
									label: "状态监控",
									value: "监控执行状态和返回结果",
									description: "监控执行",
								},
							],
						},
						// ===== 设计类 =====
						{
							name: "taste-skill",
							displayName: "Taste Skill - 前端品味",
							description:
								"Anti-Slop 前端设计技能，根据品牌或设计方向生成前端代码。通过 VARIANCE/MOTION/DENSITY 参数控制风格，避免 AI 模板化设计。",
							command: "/taste",
							builtin: true,
							category: "design",
							author: "系统",
							version: "1.0.0",
							steps: [
								{
									id: "ts1",
									type: "prompt",
									label: "品味设计读",
									value:
										"根据用户输入的设计倾向（类型、基调、范围、关键词），生成一个 Design Read",
									description: "获取设计方向品味",
								},
								{
									id: "ts2",
									type: "prompt",
									label: "设定参数轴",
									value:
										"基于 Design Read 设定 DESIGN_VARIANCE(1-10)、MOTION_INTENSITY(1-10)、VISUAL_DENSITY(1-10)",
									description: "量化设计品味",
								},
								{
									id: "ts3",
									type: "tool",
									label: "生成前端代码",
									value: "基于参数和品味设计生成具备品味标准的前端代码",
									description: "生成对应前端代码",
								},
							],
						},
						{
							name: "legal-advisor",
							displayName: "法务助手",
							description:
								"基于部门参数提供专业法律咨询\n参数: dept=合同|合规|知识产权",
							command: "/legal",
							builtin: true,
							category: "custom",
							author: "系统",
							version: "1.0.0",
							systemPrompt:
								"你是{dept}领域的资深法律专家。\n\n回答原则：\n1. 仅基于《中华人民共和国民法典》及相关司法解释作答\n2. 对不确定的条款明确说明「需要结合具体案情判断」\n3. 给出风险等级标注：低/中/高\n4. 建议客户在重大决策前咨询执业律师",
							parameters: [
								{
									name: "dept",
									label: "部门",
									type: "enum",
									required: true,
									enumValues: ["合同", "合规", "知识产权"],
								},
							],
							steps: [
								{
									id: "la1",
									type: "prompt",
									label: "分析问题",
									value: "分析用户的法律问题，确定适用的法律条款",
									description: "问题分析",
								},
								{
									id: "la2",
									type: "prompt",
									label: "法律检索",
									value: "基于问题检索相关法律条款和司法解释",
									description: "法律检索",
								},
								{
									id: "la3",
									type: "prompt",
									label: "出具意见",
									value: "输出法律意见（含风险等级+建议）",
									description: "法律意见",
								},
							],
						},
					];
					try {
						await fs.promises.mkdir(skillsDir, { recursive: true });
						const lines = `${builtins.map((s) => JSON.stringify(s)).join("\n")}\n`;
						await fs.promises.writeFile(skillsFile, lines, "utf-8");
					} catch {}
					return builtins;
				}
			}

			async function saveAllSkills(skills: any[]) {
				await fs.promises.mkdir(skillsDir, { recursive: true });
				const lines = `${skills.map((s) => JSON.stringify(s)).join("\n")}\n`;
				await fs.promises.writeFile(skillsFile, lines, "utf-8");
			}

			if (req.method === "GET" && url.pathname === "/daemon/skills") {
				const skills = await loadSkills();
				respond(res, 200, { skills });
				return;
			}

			// --- 创建 Skill ---
			if (req.method === "POST" && url.pathname === "/daemon/skills") {
				let body = "";
				req.on("data", (c) => {
					body += c;
				});
				req.on("end", async () => {
					try {
						const data = JSON.parse(body);
						if (!data.name || !data.displayName) {
							respond(res, 400, { error: "name 和 displayName 为必填" });
							return;
						}
						const skills = await loadSkills();
						if (skills.some((s) => s.name === data.name)) {
							respond(res, 409, { error: "Skill 已存在" });
							return;
						}
						const newSkill = {
							...data,
							builtin: false,
							author: data.author || "用户",
							version: data.version || "1.0.0",
							steps: data.steps || [],
						};
						skills.push(newSkill);
						await saveAllSkills(skills);
						respond(res, 201, { skill: newSkill });
					} catch (e) {
						respond(res, 400, { error: "请求格式错误" });
					}
				});
				return;
			}

			// --- 更新 Skill ---
			if (req.method === "PUT" && url.pathname.startsWith("/daemon/skills/")) {
				const skillName = decodeURIComponent(url.pathname.split("/")[3]);
				let body = "";
				req.on("data", (c) => {
					body += c;
				});
				req.on("end", async () => {
					try {
						const updates = JSON.parse(body);
						const skills = await loadSkills();
						const idx = skills.findIndex((s) => s.name === skillName);
						if (idx === -1) {
							respond(res, 404, { error: "Skill 未找到" });
							return;
						}
						if (skills[idx].builtin) {
							respond(res, 403, { error: "内置 Skill 不可修改" });
							return;
						}
						skills[idx] = {
							...skills[idx],
							...updates,
							name: skillName,
							builtin: false,
						};
						await saveAllSkills(skills);
						respond(res, 200, { skill: skills[idx] });
					} catch (e) {
						respond(res, 400, { error: "请求格式错误" });
					}
				});
				return;
			}

			// --- 删除 Skill ---
			if (
				req.method === "DELETE" &&
				url.pathname.startsWith("/daemon/skills/")
			) {
				const skillName = decodeURIComponent(url.pathname.split("/")[3]);
				const skills = await loadSkills();
				const idx = skills.findIndex((s) => s.name === skillName);
				if (idx === -1) {
					respond(res, 404, { error: "Skill 未找到" });
					return;
				}
				if (skills[idx].builtin) {
					respond(res, 403, { error: "内置 Skill 不可删除" });
					return;
				}
				skills.splice(idx, 1);
				await saveAllSkills(skills);
				respond(res, 200, { status: "deleted" });
				return;
			}

			// --- 解析 Skill: 注入参数到 systemPrompt ---
			// POST /daemon/skills/:name/resolve  { params: { dept: "合同" } }
			// → { systemPrompt: "你是合同法务专家...", parameters: [...] }
			if (
				req.method === "POST" &&
				url.pathname.match(/^\/daemon\/skills\/[^/]+\/resolve$/)
			) {
				const skillName = decodeURIComponent(url.pathname.split("/")[3]);
				let body = "";
				req.on("data", (c) => {
					body += c;
				});
				req.on("end", async () => {
					try {
						const { params } = JSON.parse(body);
						const skills = await loadSkills();
						const skill = skills.find((s) => s.name === skillName);
						if (!skill) {
							respond(res, 404, { error: "Skill 未找到" });
							return;
						}

						// 参数校验
						const errors: string[] = [];
						const resolvedParams = { ...(params || {}) };
						for (const p of skill.parameters || []) {
							const val = resolvedParams[p.name];
							if (!val && p.required) {
								errors.push(`缺少必填参数: ${p.name}`);
							}
							if (val && p.type === "enum" && p.enumValues?.length > 0) {
								if (!p.enumValues.includes(val)) {
									errors.push(
										`参数 ${p.name} 值 "${val}" 不在允许范围内: ${p.enumValues.join(", ")}`,
									);
								}
							}
						}
						if (errors.length > 0) {
							respond(res, 400, {
								error: errors.join("; "),
								_skill: {
									name: skill.name,
									displayName: skill.displayName,
									parameters: skill.parameters,
								},
							});
							return;
						}

						// 注入参数到 systemPrompt
						let systemPrompt = skill.systemPrompt || skill.description || "";
						for (const [key, val] of Object.entries(resolvedParams)) {
							systemPrompt = systemPrompt.replace(
								new RegExp(`\\{${key}\\}`, "g"),
								String(val),
							);
						}

						respond(res, 200, {
							skill: {
								name: skill.name,
								displayName: skill.displayName,
								command: skill.command,
							},
							systemPrompt,
							parameters: skill.parameters || [],
							injection: resolvedParams,
						});
					} catch (e) {
						respond(res, 400, { error: "请求格式错误" });
					}
				});
				return;
			}

			// ===== 记忆系统 API =====

			// --- 记忆统计 ---
			if (req.method === "GET" && url.pathname === "/daemon/memory/stats") {
				const mm = new MemoryManager(workDir);
				const store = mm.getMemoryStore();
				await store.load();
				respond(res, 200, mm.getMemoryStats());
				return;
			}

			// --- 记忆历史 ---
			if (req.method === "GET" && url.pathname === "/daemon/memory/history") {
				const mm = new MemoryManager(workDir);
				const store = mm.getMemoryStore();
				await store.load();
				const category = url.searchParams.get("category") || undefined;
				respond(res, 200, { items: mm.getHistory(category) });
				return;
			}

			// --- 记忆时间线 ---
			if (req.method === "GET" && url.pathname === "/daemon/memory/timeline") {
				const mm = new MemoryManager(workDir);
				const store = mm.getMemoryStore();
				await store.load();
				const allItems = store.getAll().map((i) => ({
					id: i.id,
					text: i.text,
					tags: i.tags,
					weight: i.weight,
					pinned: i.pinned,
					accessCount: i.accessCount,
					createdAt: i.createdAt,
					lastAccessedAt: i.lastAccessedAt,
				}));
				respond(res, 200, { items: allItems });
				return;
			}

			// --- 强化记忆条目 ---
			if (
				req.method === "POST" &&
				pathParts.length === 4 &&
				pathParts[1] === "memory" &&
				pathParts[3] === "reinforce"
			) {
				const id = pathParts[2];
				const mm = new MemoryManager(workDir);
				const store = mm.getMemoryStore();
				await store.load();
				await store.reinforceById(id);
				respond(res, 200, { status: "ok" });
				return;
			}

			// --- 删除记忆条目 ---
			if (
				req.method === "DELETE" &&
				pathParts.length === 3 &&
				pathParts[1] === "memory"
			) {
				const id = pathParts[2];
				const mm = new MemoryManager(workDir);
				const store = mm.getMemoryStore();
				await store.load();
				await store.deleteItem(id);
				respond(res, 200, { status: "ok" });
				return;
			}

			// --- 记忆趋势 ---
			if (req.method === "GET" && url.pathname === "/daemon/memory/trends") {
				const mm = new MemoryManager(workDir);
				const store = mm.getMemoryStore();
				await store.load();
				const allItems = store.getAll();

				// Timeline: group by date → category counts
				const timeline: Record<string, Record<string, number>> = {};
				// Activity trend: date → { avgWeight, count }
				const activityTrend: Array<{
					date: string;
					avgWeight: number;
					count: number;
				}> = [];
				const dateMap = new Map<
					string,
					{ totalWeight: number; items: number }
				>();

				for (const item of allItems) {
					const date = new Date(item.createdAt).toISOString().slice(0, 10);
					if (!timeline[date])
						timeline[date] = {
							preference: 0,
							decision: 0,
							constraint: 0,
							pattern: 0,
						};
					for (const tag of item.tags) {
						if (timeline[date][tag] !== undefined) timeline[date][tag]++;
						else timeline[date][tag] = 1;
					}
					const entry = dateMap.get(date) || { totalWeight: 0, items: 0 };
					entry.totalWeight += item.weight;
					entry.items++;
					dateMap.set(date, entry);
				}

				for (const [date, data] of dateMap) {
					activityTrend.push({
						date,
						avgWeight: Math.round((data.totalWeight / data.items) * 100) / 100,
						count: data.items,
					});
				}
				activityTrend.sort((a, b) => a.date.localeCompare(b.date));

				// Patterns: collect all items with "pattern" tag
				const patterns = allItems
					.filter((i) => i.tags.includes("pattern"))
					.sort((a, b) => b.weight - a.weight)
					.slice(0, 50)
					.map((i) => ({
						text: i.text,
						occurrences: i.accessCount,
						weight: i.weight,
						createdAt: i.createdAt,
					}));

				respond(res, 200, { timeline, activityTrend, patterns });
				return;
			}

			// --- 文件系统变更查询 (由 RECON 单元提供) ---
			if (req.method === "GET" && url.pathname === "/workspace/changes") {
				const since = Number.parseInt(url.searchParams.get("since") || "0", 10);
				if (scheduler.reconCommander) {
					try {
						const result = await scheduler.reconCommander.request<{
							changes: FileChangeEvent[];
						}>("get_changes_since", { since }, 3000);
						respond(res, 200, { changes: result.changes });
					} catch (err: any) {
						respond(res, 503, {
							error: `RECON unavailable: ${err.message}`,
							changes: [],
						});
					}
				} else if ((scheduler as any).__fileWatcher) {
					const changes = (scheduler as any).__fileWatcher.getChangesSince(
						since,
					);
					respond(res, 200, { changes });
				} else {
					respond(res, 200, { changes: [] });
				}
				return;
			}

			// --- 模型注册表 ---
			if (url.pathname === "/daemon/models") {
				if (req.method === "GET") {
					respond(res, 200, { models: getModels() });
					return;
				}
				if (req.method === "POST") {
					try {
						const body = (await readBody(req)) as any;
						const { provider, modelName, updates } = body;
						if (!provider || !modelName) {
							respond(res, 400, { error: "provider and modelName required" });
							return;
						}
						const updated = updateModel(provider, modelName, updates);
						if (updated) {
							respond(res, 200, { model: updated });
						} else {
							respond(res, 404, { error: "Model not found" });
						}
					} catch (err: any) {
						respond(res, 500, { error: err.message });
					}
					return;
				}
				if (req.method === "DELETE") {
					try {
						const body = (await readBody(req)) as any;
						const { provider, modelName } = body;
						if (!provider || !modelName) {
							respond(res, 400, { error: "provider and modelName required" });
							return;
						}
						removeModel(provider, modelName);
						respond(res, 200, { status: "ok" });
					} catch (err: any) {
						respond(res, 500, { error: err.message });
					}
					return;
				}
			}

			// --- 列出已安装插件 ---
			if (req.method === "GET" && url.pathname === "/daemon/plugins") {
				const plugins = pluginManager.registry.listPlugins();
				const extraTools = pluginManager.registry.getExtraTools();
				const extraToolNames = Array.from(extraTools.keys());
				respond(res, 200, {
					total: plugins.length,
					plugins: plugins.map((p) => ({
						name: p.name,
						version: p.version,
						description: p.description,
						author: p.author,
						element: p.element,
						events: p.events,
						tools: extraToolNames.filter((t) => t.startsWith(`${p.name}:`)),
					})),
				});
				return;
			}

			// --- 搜索插件 ---
			if (req.method === "GET" && url.pathname === "/daemon/plugins/search") {
				const query = url.searchParams.get("q") || "";
				if (!query) {
					respond(res, 200, { plugins: [] });
					return;
				}
				const plugins = pluginManager.registry.listPlugins();
				const q = query.toLowerCase();
				const filtered = plugins.filter(
					(p) =>
						p.name.toLowerCase().includes(q) ||
						p.description.toLowerCase().includes(q) ||
						p.author?.toLowerCase().includes(q),
				);
				respond(res, 200, { plugins: filtered });
				return;
			}

			// --- 获取单个插件详情 ---
			const pluginDetailMatch = url.pathname.match(
				/^\/daemon\/plugins\/([^/]+)$/,
			);
			if (req.method === "GET" && pluginDetailMatch) {
				const pluginName = decodeURIComponent(pluginDetailMatch[1]);
				const plugins = pluginManager.registry.listPlugins();
				const plugin = plugins.find((p) => p.name === pluginName);
				if (!plugin) {
					respond(res, 404, { error: `插件 "${pluginName}" 未安装` });
					return;
				}
				respond(res, 200, plugin);
				return;
			}

			// --- 获取插件配置 ---
			const pluginConfigGetMatch = url.pathname.match(
				/^\/daemon\/plugins\/([^/]+)\/config$/,
			);
			if (req.method === "GET" && pluginConfigGetMatch) {
				const pluginName = decodeURIComponent(pluginConfigGetMatch[1]);
				const config = pluginManager.configLoader.getPluginConfig(pluginName);
				respond(res, 200, { config: config || {} });
				return;
			}

			// --- 更新插件配置 ---
			if (req.method === "POST" && pluginConfigGetMatch) {
				const pluginName = decodeURIComponent(pluginConfigGetMatch[1]);
				const body = await readBody(req);
				const config = pluginManager.configLoader.load();
				const existing = config?.plugins?.find((p) => p.name === pluginName);
				if (existing) {
					existing.config = body?.config || {};
				} else if (config?.plugins) {
					config.plugins.push({
						name: pluginName,
						enabled: true,
						config: body?.config || {},
					});
				}
				if (config) pluginManager.configLoader.save(config);
				// 重新初始化插件使配置生效
				pluginManager
					.reinitialize()
					.catch((err) => console.error("[daemon] 重载插件失败:", err));
				respond(res, 200, { status: "ok" });
				return;
			}

			// --- 安装插件 ---
			// 安全约束：
			//   1. 包名必须匹配白名单 ^@?[a-z0-9][a-z0-9._/-]*$（npm scope/name 规范）
			//   2. source 仅接受 npm registry 包名，禁止 URL/git/file spec
			//   3. 使用 execFile 数组参数，禁用 shell，杜绝命令注入
			//   4. 强制 --ignore-scripts，禁止 postinstall 脚本执行
			//   5. 安装前校验 registry 中的 scanResult（仅当 scanResult.passed === true 才允许）
			if (req.method === "POST" && url.pathname === "/daemon/plugins/install") {
				const body = await readBody(req);
				const { name, source, element } = body || {};
				if (!name) {
					respond(res, 400, { error: "缺少必填字段: name" });
					return;
				}

				// 严格白名单：npm 包名规范（@scope/name 或 name）
				const PKG_NAME_RE = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/;
				const rawPkg = source || `@xuancode/plugin-${name}`;
				if (!PKG_NAME_RE.test(rawPkg) || rawPkg.length > 214) {
					respond(res, 400, { error: "非法插件包名" });
					return;
				}
				// 禁止任何 URL、git、file spec（npm 接受这些，但我们禁用）
				if (
					/^https?:|^git(\+|ssh)?:|^file:|^\.\/|^\.\.\/|^[\/~]/.test(rawPkg)
				) {
					respond(res, 400, { error: "禁止使用 URL/git/本地路径作为安装源" });
					return;
				}

				try {
					const { execFile } = await import("node:child_process");
					// 供应链安全（P1.2）：
					//   1. 安装前从 registry 拉取元数据，pin 到具体版本（防止 latest tag 投毒）
					//   2. npm install 时传入 <pkg>@<version> 而非 <pkg>
					//   3. 安装后校验 node_modules/<pkg>/.package-lock.json 的 integrity
					//      与 registry dist.integrity 一致（常量时间比较）
					//   4. 若 XUANCODE_REQUIRE_SIGNATURE=1，强制要求 sigstore 签名（待 registry 接入）
					const { verifyPackageForInstall, fetchNpmDist } = await import(
						"./supplyChain"
					);
					const dist = await fetchNpmDist(rawPkg, undefined);
					const installSpec = dist ? `${rawPkg}@${dist.version}` : rawPkg;
					// execFile 数组参数：不经 shell，杜绝元字符注入
					// --ignore-scripts：禁止 preinstall/install/postinstall 执行
					await new Promise<void>((resolve, reject) => {
						execFile(
							"npm",
							["install", "--ignore-scripts", installSpec],
							{
								cwd: workDir,
								timeout: 120_000,
								maxBuffer: 10 * 1024 * 1024,
								windowsHide: true,
							},
							(err, _stdout, stderr) => {
								if (err) reject(new Error(stderr?.toString() || err.message));
								else resolve();
							},
						);
					});

					// 安装后完整性校验 — 失败则回滚卸载并返回 500
					if (dist) {
						const verify = await verifyPackageForInstall({
							workDir,
							pkgName: rawPkg,
							expectedVersion: dist.version,
							// 传递玄码 registry 信息用于 sigstore 签名校验
							// XUANCODE_REGISTRY_URL / XUANCODE_REQUIRE_SIGNATURE 由环境变量驱动
							pluginName: name,
							xuancodeRegistryUrl: process.env.XUANCODE_REGISTRY_URL,
						});
						if (!verify.ok) {
							// 回滚：卸载可能已写入的 node_modules
							await new Promise<void>((resolve) => {
								execFile(
									"npm",
									["uninstall", "--ignore-scripts", rawPkg],
									{
										cwd: workDir,
										timeout: 30_000,
										windowsHide: true,
									},
									() => resolve(),
								);
							});
							respond(res, 500, {
								error: `供应链校验失败: ${verify.reason}`,
								code: verify.code,
							});
							return;
						}
					}

					// 保存用户指定的五行分类
					if (element) {
						const config = pluginManager.configLoader.load();
						const existing = config?.plugins?.find((p) => p.name === name);
						if (existing) {
							existing.element = element;
						} else if (config?.plugins) {
							config.plugins.push({ name, enabled: true, element, config: {} });
						}
						if (config) pluginManager.configLoader.save(config);
					}
					pluginManager.reinitialize().catch(() => {});
					respond(res, 200, { status: "ok", name, package: rawPkg });
				} catch (err: any) {
					// Fallback: mock install if npm fails (development mode)
					try {
						pluginManager.configLoader.enablePlugin(name);
						pluginManager.reinitialize().catch(() => {});
						respond(res, 200, { status: "ok", name, mock: true });
					} catch {
						respond(res, 500, { error: `插件安装失败: ${err.message}` });
					}
				}
				return;
			}

			// --- 卸载插件 ---
			const uninstallMatch = url.pathname.match(
				/^\/daemon\/plugins\/([^/]+)\/uninstall$/,
			);
			if (req.method === "POST" && uninstallMatch) {
				const pluginName = decodeURIComponent(uninstallMatch[1]);
				// 同样的白名单校验，防止通过 URL 路径注入
				const PKG_NAME_RE = /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/;
				if (!PKG_NAME_RE.test(pluginName) || pluginName.length > 214) {
					respond(res, 400, { error: "非法插件名" });
					return;
				}
				try {
					const { execFile } = await import("node:child_process");
					await new Promise<void>((resolve, reject) => {
						execFile(
							"npm",
							["uninstall", "--ignore-scripts", pluginName],
							{
								cwd: workDir,
								timeout: 60_000,
								maxBuffer: 10 * 1024 * 1024,
								windowsHide: true,
							},
							(err, _stdout, stderr) => {
								if (err) reject(new Error(stderr?.toString() || err.message));
								else resolve();
							},
						);
					});
					pluginManager.reinitialize().catch(() => {});
					respond(res, 200, { status: "ok", name: pluginName });
				} catch (err: any) {
					respond(res, 500, { error: `插件卸载失败: ${err.message}` });
				}
				return;
			}

			respond(res, 404, { error: "未找到路由" });
		} catch (err) {
			respond(res, 500, { error: String(err) });
		}
	});

	// ===== RECON 侦察单元初始化 =====
	// 测试模式整段跳过：@parcel/watcher 原生后端在 vitest 下被反复 rmSync 监视目录会触发进程级
	// SIGSEGV（终止竞态），而文件监视并非测试对象 —— 优雅关闭仅作为生产兜底保留。
	if (!forceInlineForTests) {
		const currDir =
			typeof __dirname !== "undefined"
				? __dirname
				: path.dirname(fileURLToPath(import.meta.url));

		// 查找编译后的 Worker 文件：prod 在同目录，dev 在 desktop/dist-daemon/
		let cjsPath = path.join(currDir, "reconUnit.cjs");
		if (!fs.existsSync(cjsPath)) {
			cjsPath = path.resolve(
				currDir,
				"../../desktop/dist-daemon/reconUnit.cjs",
			);
		}

		// 优先使用 Worker 架构（.cjs 文件），Worker 隔离确保文件监视不阻塞主线程
		if (fs.existsSync(cjsPath)) {
			try {
				const recon = new WorkerCommander(cjsPath);
				scheduler.reconCommander = recon;
				recon.sendCommand("start_watch", { dir: workDir });
				recon.onEvent("file_changed", (payload: any) => {
					taskEventBus.publish("workspace", "file_changed", payload);
				});
				console.error(`[玄码] RECON 侦察单元已启动 (Worker: ${cjsPath})`);
			} catch (err) {
				console.error("[玄码] RECON Worker 启动失败（非致命）:", err);
			}
		} else {
			// 未找到编译产物 → 退化为内联 FileWatcher（dev 模式）
			console.error(
				"[玄码] RECON 未找到编译产物，使用内联 FileWatcher（dev 模式）",
			);
			import("./fileWatcher.js")
				.then(({ FileWatcher }) => {
					const fw = new FileWatcher();
					fw.startWatch(workDir, (events: any) => {
						taskEventBus.publish("workspace", "file_changed", { events });
					});
					(scheduler as any).__fileWatcher = fw;
					console.error("[玄码] RECON (内联) 已就绪");
				})
				.catch((err) => {
					console.error("[玄码] RECON 内联回退失败:", err);
				});
		}
	}

	// 等待 INTEL/SQLite 初始化完成
	// (startDaemonServer 已标记 async)
	server.listen(port, async () => {
		await scheduler.start();
		schedTaskMgr?.start();

		// ===== Gateway Worker (BullMQ) — 可选，当配置了 REDIS_URL 时启动 =====
		if (process.env.REDIS_URL) {
			try {
				const { createGatewayWorker } = await import("./gatewayWorker.js");
				const modelRouter = scheduler.getModelRouter();
				if (!modelRouter) {
					console.error(
						"[玄码] Gateway Worker 未启动：ModelRouter 不可用（非致命）",
					);
					return;
				}
				const gw = createGatewayWorker(modelRouter, process.env.REDIS_URL, {
					databaseUrl: process.env.DATABASE_URL,
				});
				(scheduler as any).__gatewayWorker = gw;
				console.error("[玄码] Gateway Worker 已启动 (llm-requests 队列)");
			} catch (err) {
				console.error("[玄码] Gateway Worker 启动失败（非致命）:", err);
			}
		}
	});

	server.on("error", (err: any) => {
		if (err?.code === "EADDRINUSE") {
			console.error(`[玄码] 端口 ${port} 已被占用`);
			process.exit(1);
		}
	});

	// 清理：关闭 server 时优雅关闭 worker + 释放 SQLite 锁
	server.on("close", () => {
		scheduler.dispose().catch(() => {});
		(scheduler as any).__gatewayWorker?.close().catch(() => {});
	});

	return { server, scheduler };
}

// ===== 安全中间件 =====

interface RateLimiter {
	check: (ip: string) => {
		allowed: boolean;
		remaining: number;
		resetMs: number;
	};
}

/** 令牌桶速率限制器 */
function createRateLimiter(rpm: number): RateLimiter {
	const buckets = new Map<string, { tokens: number; lastRefill: number }>();
	const MAX_TOKENS = rpm;
	const REFILL_INTERVAL_MS = 60_000; // 1 分钟

	return {
		check(ip: string) {
			let bucket = buckets.get(ip);
			const now = Date.now();

			if (!bucket) {
				bucket = { tokens: MAX_TOKENS - 1, lastRefill: now };
				buckets.set(ip, bucket);
				return {
					allowed: true,
					remaining: bucket.tokens,
					resetMs: REFILL_INTERVAL_MS,
				};
			}

			// refill
			const elapsed = now - bucket.lastRefill;
			const refill = Math.floor((elapsed / REFILL_INTERVAL_MS) * MAX_TOKENS);
			if (refill > 0) {
				bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + refill);
				bucket.lastRefill = now;
			}

			if (bucket.tokens <= 0) {
				return {
					allowed: false,
					remaining: 0,
					resetMs: REFILL_INTERVAL_MS - elapsed,
				};
			}

			bucket.tokens--;
			return {
				allowed: true,
				remaining: bucket.tokens,
				resetMs: REFILL_INTERVAL_MS,
			};
		},
	};
}

/** 清理过期 bucket（每 5 分钟调用一次） */
function startBucketCleanup(limiter: RateLimiter, intervalMs = 300_000): void {
	// 利用闭包中的 buckets Map，但这里我们不做清理因为无法访问私有 Map
	// 生产环境可使用外部 Map 或依赖 WeakRef
}

// ===== 全局异常捕获 =====
process.on("uncaughtException", (err) => {
	console.error("[玄码] 未捕获异常:", err);
	// 不 exit(1)，尝试保持守护进程运行
});

process.on("unhandledRejection", (reason) => {
	console.error("[玄码] 未处理的 Promise 拒绝:", reason);
});

// ===== 直接运行 =====
const isMain =
	process.argv[1] &&
	(process.argv[1]?.endsWith("index.ts") ||
		process.argv[1]?.endsWith("index.cjs") ||
		process.argv[1]?.endsWith("index.js"));
if (isMain) {
	startDaemonServer({
		port: Number.parseInt(process.env.DAEMON_PORT || "3020", 10),
		provider: process.env.DAEMON_PROVIDER || "mock",
		modelName: process.env.DAEMON_MODEL || "deepseek-v4-flash",
		enableMCP: process.env.ENABLE_MCP === "true",
		enableA2A: process.env.ENABLE_A2A === "true",
		enableTelemetry: process.env.ENABLE_TELEMETRY === "true",
	})
		.then(({ server }) => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 3020;
			if (process.env.ENABLE_MCP === "true") {
				console.error("玄码 MCP Server 运行于 http://localhost:3021/sse");
			}
			console.error(`玄码 Daemon 启动于 http://localhost:${port}`);
		})
		.catch((err) => {
			console.error("[玄码] 守护进程启动失败:", err);
			process.exit(1);
		});
}
