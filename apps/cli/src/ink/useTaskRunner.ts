/**
 * useTaskRunner — 任务执行机制 hook（App.tsx 拆出）
 *
 * 拥有：运行状态、事件接线（StreamCallbacks 工厂）、任务提交（daemon/内嵌）、
 * /tasks 重连、ask_user 决策队列。
 * App.tsx 只保留命令分发与渲染。
 */

import type { ModelAdapter } from "@xuancode/model-adapter";
import type { Message, ToolResult } from "@xuancode/types";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createPlanStateReducer,
	shouldAutoPromoteToPlan,
	wrapPlanPrompt,
} from "../commands/plan";
import type {
	DaemonClient,
	StreamCallbacks,
	TaskResult,
	TaskSummary,
} from "../daemonClient";
import type { SessionRecord } from "../session";
import type { StepItem, ThreadItem } from "./ConversationThread";
import type { AskQuestion } from "./QuestionDialog";
import { buildConversationSummary } from "./appText";

export interface SessionLog {
	id: number;
	input: string;
	output: string;
	turnCount: number;
	toolCallCount: number;
}

export interface RunnerOpts {
	mode: string;
	maxTurns: number;
	maxContinuations: number;
	compactLevel: number;
}

export interface UseTaskRunnerParams {
	model?: ModelAdapter;
	daemonClient?: DaemonClient;
	workDir: string;
	/** 当前信任模式（/mode 可切换，由 App 持有） */
	mode: string;
	opts: RunnerOpts;
	saveSession?: (record: SessionRecord) => void;
	previousSessionContext?: string | null;
	/** App 侧状态横幅（/tasks 列表、回答提交失败等提示） */
	notify: (text: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
	running: "运行中",
	pending: "等待中",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

export function useTaskRunner(params: UseTaskRunnerParams) {
	const {
		model,
		daemonClient,
		workDir,
		mode,
		opts,
		saveSession,
		previousSessionContext,
		notify,
	} = params;

	const [running, setRunning] = useState(false);
	const [isThinking, setIsThinking] = useState(false);
	const [turn, setTurn] = useState(0);
	const [contextUsage, setContextUsage] = useState(0);
	const [currentOutput, setCurrentOutput] = useState("");
	const [streamingText, setStreamingText] = useState("");
	const [sessionLogs, setSessionLogs] = useState<SessionLog[]>([]);
	const [threadItems, setThreadItems] = useState<ThreadItem[]>([]);
	const [steps, setSteps] = useState<StepItem[]>([]);
	const [planSummary, setPlanSummary] = useState("");
	const [planTotal, setPlanTotal] = useState(0);
	const [progressSummary, setProgressSummary] = useState("");
	/** ask_user 决策流程：顺序累积，待答的 question.answer 为空 */
	const [questions, setQuestions] = useState<AskQuestion[]>([]);
	const [answerMode, setAnswerMode] = useState<"menu" | "text" | null>(null);

	const logIdRef = useRef(0);
	const threadIdRef = useRef(0);
	const lastUserInputRef = useRef("");
	/** 缓存对话消息历史，用于多轮输入保持记忆 */
	const threadMessagesRef = useRef<Message[]>([]);
	/** 连接模式下用于分组任务的 sessionId */
	const sessionIdRef = useRef(
		`cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	/** 当前流式任务的 taskId（ask_user 回答时使用） */
	const activeTaskIdRef = useRef("");
	const questionIdRef = useRef(0);
	const questionsRef = useRef<AskQuestion[]>([]);

	// 同步 questionsRef，避免回调闭包读到过期 questions
	useEffect(() => {
		questionsRef.current = questions;
	}, [questions]);

	const answerQuestion = useCallback(
		(answer: string) => {
			const idx = questionsRef.current.findIndex((q) => !q.answer);
			if (idx < 0) return;
			const next = questionsRef.current.map((q, i) =>
				i === idx ? { ...q, answer, answeredAt: Date.now() } : q,
			);
			questionsRef.current = next;
			setQuestions(next);
			setAnswerMode(null);
			const taskId = activeTaskIdRef.current;
			if (taskId && daemonClient) {
				daemonClient.respondInput(taskId, answer).catch((e) => {
					notify(`提交回答失败: ${(e as Error)?.message || e}`);
				});
			}
		},
		[daemonClient, notify],
	);

	/** 提交流程共用的运行态重置（新任务 / /tasks 重连都会走） */
	const beginRunUI = useCallback((displayInput: string) => {
		setRunning(true);
		setIsThinking(true);
		setCurrentOutput("");
		setStreamingText("");
		setTurn(1);
		setThreadItems([]);
		setSteps([]);
		setPlanSummary("");
		setPlanTotal(0);
		setProgressSummary("");
		setQuestions([]);
		setAnswerMode(null);
		questionsRef.current = [];
		threadIdRef.current = 0;
		lastUserInputRef.current = displayInput;
	}, []);

	/** 任务落定后的统一收尾（saveSession + 会话时间线） */
	const handleTaskResult = useCallback(
		(result: TaskResult, displayInput: string) => {
			// daemon 模式用 complete 事件带回的真实用量（旧版 daemon 无此字段 → 0）
			setContextUsage(result.contextUsage ?? 0);
			const output = result.finalAnswer || "";
			setCurrentOutput(output);

			saveSession?.({
				timestamp: Date.now(),
				userInput: displayInput,
				finalAnswer: output.slice(0, 2000),
				turnCount: result.turnCount,
				toolCallCount: result.toolCallCount,
			});

			setSessionLogs((prev) => [
				...prev,
				{
					id: logIdRef.current++,
					input: displayInput,
					output: output || "(无输出)",
					turnCount: result.turnCount,
					toolCallCount: result.toolCallCount,
				},
			]);
		},
		[saveSession],
	);

	/** StreamCallbacks 工厂：新任务与 /tasks 重连共用同一套事件接线 */
	const makeTaskCallbacks = useCallback(() => {
		// 每次任务用全新 reducer，避免上一任务的步骤状态串场
		const planReducer = createPlanStateReducer((s) => {
			setSteps(s.steps);
			setPlanSummary(s.summary);
			setPlanTotal(s.totalSteps);
		});

		const callbacks: StreamCallbacks = {
			onTurn: (t: number) => {
				setTurn(t);
				setStreamingText("");
				setIsThinking(t > 1);
			},
			onToken: (_token: string, fullText: string) => {
				setStreamingText(fullText);
			},
			onToolCall: (
				toolType: string,
				params: Record<string, unknown>,
				tr: { success: boolean; error?: string; duration?: number },
			) => {
				setIsThinking(false);
				setStreamingText("");
				setThreadItems((prev) => [
					...prev,
					{
						id: threadIdRef.current++,
						type: "tool-call" as const,
						toolType,
						params: params as Record<string, string | undefined>,
						result: {
							success: tr.success,
							data: "",
							error: tr.error,
							duration: tr.duration,
						},
						timestamp: Date.now(),
					},
				]);
			},
			onError: () => setIsThinking(false),
			onProgress: (info) => setProgressSummary(info.summary),
			onTaskCreated: (taskId) => {
				activeTaskIdRef.current = taskId;
			},
			onAskUser: (payload) => {
				const id = ++questionIdRef.current;
				const next = [
					...questionsRef.current,
					{ id, question: payload.question, options: payload.options },
				];
				questionsRef.current = next;
				setQuestions(next);
				setAnswerMode(payload.options?.length ? "menu" : "text");
			},
			onInputResumed: ({ answer }) => {
				const idx = questionsRef.current.findIndex((q) => !q.answer);
				if (idx >= 0) {
					const next = questionsRef.current.map((q, i) =>
						i === idx
							? {
									...q,
									answer: answer ?? q.answer,
									answeredAt: Date.now(),
								}
							: q,
					);
					questionsRef.current = next;
					setQuestions(next);
				}
				setAnswerMode(null);
			},
			onWorkflow: (ev) => planReducer.handleWorkflowEvent(ev),
		};
		return callbacks;
	}, []);

	/** /tasks 命令：无参数列任务，带 taskId（支持前缀）重连到运行中的任务 */
	const handleTasksCommand = useCallback(
		async (arg: string) => {
			if (!daemonClient) {
				notify("/tasks 仅在 --connect 连接模式下可用");
				return;
			}

			let tasks: TaskSummary[];
			try {
				tasks = await daemonClient.listTasks(20);
			} catch (e) {
				notify(`获取任务列表失败: ${(e as Error)?.message || e}`);
				return;
			}

			// 无参数 → 列表
			if (!arg) {
				if (tasks.length === 0) {
					notify("暂无任务记录");
					return;
				}
				const lines = tasks.slice(0, 10).map((t) => {
					const label = STATUS_LABELS[t.status] || t.status;
					const turnInfo = t.currentTurn ? ` · ${t.currentTurn}轮` : "";
					const excerpt = (t.userInput || "").replace(/\s+/g, " ").slice(0, 40);
					return `${t.id.slice(0, 8)}  ${label}${turnInfo}  ${excerpt}`;
				});
				notify(
					`最近任务（/tasks <id> 重连运行中的任务）:\n${lines.join("\n")}`,
				);
				return;
			}

			// 带参数 → 精确/前缀匹配后重连
			const matches = tasks.filter((t) => t.id === arg || t.id.startsWith(arg));
			if (matches.length === 0) {
				notify(`未找到任务: ${arg}`);
				return;
			}
			if (matches.length > 1) {
				notify(`id 前缀不唯一（${matches.length} 个匹配），请输入更多字符`);
				return;
			}
			const task = matches[0];
			if (!["running", "pending"].includes(task.status)) {
				notify(
					`任务 ${task.id.slice(0, 8)} 已结束（${STATUS_LABELS[task.status] || task.status}），无需重连`,
				);
				return;
			}

			const excerpt = (task.userInput || "").replace(/\s+/g, " ").slice(0, 60);
			beginRunUI(`[重连] ${excerpt}`);
			try {
				const result = await daemonClient.streamTask(
					task.id,
					makeTaskCallbacks(),
				);
				handleTaskResult(result, excerpt);
			} catch (e) {
				setRunning(false);
				setIsThinking(false);
				setCurrentOutput(`重连失败: ${(e as Error)?.message || e}`);
			}
		},
		[daemonClient, beginRunUI, makeTaskCallbacks, handleTaskResult, notify],
	);

	/** 普通查询：构建上下文摘要后按 连接/内嵌 模式执行 */
	const runNormal = useCallback(
		async (input: string) => {
			beginRunUI(input);

			// 构建对话上下文摘要（从上一轮的完整消息中提取，避免传入原始 Message[] 干扰停止条件）
			const prevSummary = buildConversationSummary(threadMessagesRef.current);
			const contextualInput = [
				previousSessionContext ? `[历史对话]\n${previousSessionContext}` : "",
				prevSummary ? `[上轮对话]\n${prevSummary}` : "",
				`[当前问题]\n${input}`,
			]
				.filter(Boolean)
				.join("\n\n");

			try {
				if (daemonClient) {
					// === 连接模式 ===
					const isPlanCmd = input.startsWith("/plan ");
					const enableWorkflow = isPlanCmd || shouldAutoPromoteToPlan(input);
					const taskInput = isPlanCmd
						? wrapPlanPrompt(input.slice(6).trim())
						: contextualInput;

					const result = await daemonClient.runTask(
						taskInput,
						{
							mode: mode as any,
							maxTurns: opts.maxTurns,
							maxContinuations: opts.maxContinuations ?? 0,
							compactLevel: opts.compactLevel ?? 1,
							compactThreshold: 0.7,
							sessionId: sessionIdRef.current,
							...(enableWorkflow ? { enableWorkflow: true } : {}),
						},
						makeTaskCallbacks(),
					);

					handleTaskResult(result, input);
				} else {
					// === 内嵌模式 ===
					if (!model) {
						setCurrentOutput("内部错误: 既没有模型适配器也没有 Daemon 客户端");
						setRunning(false);
						setIsThinking(false);
						return;
					}

					const { runTaorLoop } = await import("@xuancode/orchestrator");
					const sp = (globalThis as any).__xuancode_sessionPersistence;
					const { SessionCollector: SC } = await import("@xuancode/database");
					const collector = new SC();
					let lastTurn = 0;

					// /plan 输入与复杂任务自动升级 → 启用工作流（与连接模式行为一致）
					const isPlanCmd = input.startsWith("/plan ");
					const enableWorkflow = isPlanCmd || shouldAutoPromoteToPlan(input);
					const embeddedInput = isPlanCmd
						? wrapPlanPrompt(input.slice(6).trim())
						: contextualInput;

					const planReducer = createPlanStateReducer((s) => {
						setSteps(s.steps);
						setPlanSummary(s.summary);
						setPlanTotal(s.totalSteps);
					});

					const result = await runTaorLoop(embeddedInput, {
						model,
						workDir,
						enableWorkflow,
						onHook: (event, context) => {
							if (event === "WorkflowEvent") {
								planReducer.handleWorkflowEvent(context as any);
							}
						},
						config: {
							mode: mode as any,
							maxTurns: opts.maxTurns,
							maxContinuations: opts.maxContinuations ?? 0,
							compactLevel: opts.compactLevel ?? 1,
							compactThreshold: 0.7,
						},
						onTurn: (t, state) => {
							lastTurn = t;
							setTurn(t);
							setStreamingText("");
							setIsThinking(t > 1);
							collector.captureNewMessages(t, state);
							threadMessagesRef.current = (state as any)?.messages || [];
						},
						onToken: (_token: string, fullText: string) => {
							setStreamingText(fullText);
						},
						onToolCall: (_tc: any, tr: ToolResult) => {
							const tc = _tc as any;
							setIsThinking(false);
							setStreamingText("");
							setThreadItems((prev) => [
								...prev,
								{
									id: threadIdRef.current++,
									type: "tool-call",
									toolType: tc.type,
									params: {
										path: tc.path,
										command: tc.command,
										pattern: tc.pattern,
									},
									result: tr,
									timestamp: Date.now(),
								},
							]);
							collector.captureToolCall(lastTurn, tc, tr);
						},
						onError: (msg: string, site: string) => {
							setIsThinking(false);
							collector.captureError(lastTurn, msg, site);
						},
						onProgress: (info) => setProgressSummary(info.summary),
					});

					setContextUsage(result.contextUsage);
					const output = result.finalAnswer || "";
					setCurrentOutput(output);

					// 保存完整会话到 SQLite
					try {
						const sessionId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
						const entries = collector.getEntries();
						entries.unshift({
							type: "session_meta",
							sessionId,
							createdAt: new Date().toISOString(),
							config: { mode: mode as any, maxTurns: opts.maxTurns },
							userInput: input,
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
						sp?.saveSession(sessionId, entries);
					} catch {
						/* SQLite save non-fatal */
					}
					// 自动蒸馏（fire-and-forget）
					if (threadMessagesRef.current.length >= 4) {
						import("@xuancode/distiller")
							.then(({ SessionDistiller: SD }) => {
								new SD(model, workDir)
									.distillAndPersist(threadMessagesRef.current)
									.catch(() => {});
							})
							.catch(() => {});
					}

					saveSession?.({
						timestamp: Date.now(),
						userInput: input,
						finalAnswer: output.slice(0, 2000),
						turnCount: result.turnCount,
						toolCallCount: result.toolCallCount,
					});

					setSessionLogs((prev) => [
						...prev,
						{
							id: logIdRef.current++,
							input,
							output: output || "(无输出)",
							turnCount: result.turnCount,
							toolCallCount: result.toolCallCount,
						},
					]);
				}
			} catch (err) {
				const errorMsg = daemonClient
					? `与 Daemon 的连接已断开: ${err}`
					: `执行出错: ${err}`;
				setCurrentOutput(errorMsg);
			} finally {
				setRunning(false);
				setIsThinking(false);
				setStreamingText("");
			}
		},
		[
			beginRunUI,
			previousSessionContext,
			daemonClient,
			mode,
			opts,
			makeTaskCallbacks,
			handleTaskResult,
			model,
			workDir,
			saveSession,
		],
	);

	return {
		// 渲染态
		running,
		isThinking,
		turn,
		contextUsage,
		currentOutput,
		streamingText,
		sessionLogs,
		threadItems,
		steps,
		planSummary,
		planTotal,
		progressSummary,
		questions,
		answerMode,
		lastUserInput: lastUserInputRef,
		// 交互
		answerQuestion,
		setAnswerMode,
		handleTasksCommand,
		runNormal,
		/** 决策面板文本回答模式：待答问题存在时把输入当作回答 */
		questionsRef,
	};
}
