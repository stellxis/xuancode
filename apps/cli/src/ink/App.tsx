import { MemoryManager } from "@xuancode/context";
import type { SessionCollector, SessionPersistence } from "@xuancode/database";
import type { ModelAdapter } from "@xuancode/model-adapter";
import type { Message, ToolResult } from "@xuancode/types";
import { Box, Static, Text, useInput } from "ink";
import React, { useState, useCallback, useRef, useEffect } from "react";
import type { DaemonClient, TaskResult } from "../daemonClient";
import Banner from "./Banner";
import ContextWaterline from "./ContextWaterline";
import ConversationThread, {
	type ThreadItem,
	type StepItem,
} from "./ConversationThread";
import InputBar from "./InputBar";
import QuestionDialog, { type AskQuestion } from "./QuestionDialog";
import StatusLine from "./StatusLine";
import { parseMarkdownLine } from "./markdown";
import { colors } from "./theme";
import { THREAD } from "./threadConst";

interface SessionRecord {
	timestamp: number;
	userInput: string;
	finalAnswer: string;
	turnCount: number;
	toolCallCount: number;
}

interface AppProps {
	model?: ModelAdapter;
	daemonClient?: DaemonClient;
	workDir: string;
	opts: {
		mode: string;
		provider: string;
		modelName: string;
		maxTurns: number;
		maxContinuations: number;
		compactLevel: number;
	};
	saveSession?: (record: SessionRecord) => void;
	clearSessions?: () => void;
	previousSessionContext?: string | null;
}

interface SessionLog {
	id: number;
	input: string;
	output: string;
	turnCount: number;
	toolCallCount: number;
}

/** CJK 双宽字符判断 + 框线字符 + 表情符号 + 特殊符号 */
function isCJK(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (
		(code >= 0x4e00 && code <= 0x9fff) || // CJK 汉字
		(code >= 0x3000 && code <= 0x303f) || // CJK 符号
		(code >= 0xff00 && code <= 0xffef) || // 全角字符
		(code >= 0x2500 && code <= 0x257f) || // 框线字符 ▐│├┤等
		(code >= 0x1f300 && code <= 0x1f9ff) || // 表情符号
		(code >= 0x2600 && code <= 0x26ff) || // 杂项符号
		code === 0x25cf
	); // ● 黑色圆点
}

/** 计算终端视觉宽度（CJK=2, ASCII=1） */
function visualLen(s: string): number {
	let len = 0;
	for (const ch of s) len += isCJK(ch) ? 2 : 1;
	return len;
}

/** 按视觉宽度换行 */
function wrapVisual(text: string, maxVisual: number): string[] {
	if (maxVisual <= 0 || visualLen(text) <= maxVisual) return [text];
	const lines: string[] = [];
	let start = 0;
	while (start < text.length) {
		let visual = 0;
		let end = start;
		while (end < text.length) {
			const next = visual + (isCJK(text[end]) ? 2 : 1);
			if (next > maxVisual) break;
			visual = next;
			end++;
		}
		if (end === start) end = start + 1;
		lines.push(text.slice(start, end));
		start = end;
	}
	return lines;
}

/** 将 Message[] 转成文本摘要（用于跨轮对话上下文，避免原始 Message[] 干扰停止条件） */
function buildConversationSummary(messages: Message[]): string {
	if (messages.length === 0) return "";
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user" && !msg.content.startsWith("工具结果:")) {
			const truncated =
				msg.content.length > 500
					? `${msg.content.slice(0, 500)}…`
					: msg.content;
			parts.push(`用户: ${truncated}`);
		} else if (msg.role === "assistant") {
			const truncated =
				msg.content.length > 1000
					? `${msg.content.slice(0, 1000)}…`
					: msg.content;
			parts.push(`玄码: ${truncated}`);
		}
	}
	return parts.join("\n").slice(0, 4000);
}

const HELP_TEXT = `
  ┌─ 玄码指令 ─────────────────────────────────────────┐
  │ /help          — 显示此帮助面板                       │
  │ /status        — 显示当前状态                        │
  │ /plan <任务>   — 先规划再执行多步骤任务               │
  │ /mode <模式>   — 切换信任模式                        │
  │                  plan / default / trust / auto / bypass │
  │ /clear         — 清除会话历史                        │
  │ exit/quit      — 退出玄码                           │
  └────────────────────────────────────────────────────┘

  信任模式:
    观(plan)    — 仅规划，不执行任何操作
    问(default) — 每次执行前询问
    信(trust)   — 文件自动，Shell 询问
    任(auto)    — 自动决策低风险操作
    化(bypass)  — 完全自动，不确认

  快捷键:
    Ctrl+L       — 清除会话
    Escape       — 关闭帮助面板
`;

/* Suggestion engine for inline help */
function getSuggestions(prefix: string): string[] {
	if (!prefix) return [];
	const commands = [
		"/help",
		"/status",
		"/plan ",
		"/mode plan",
		"/mode default",
		"/mode trust",
		"/mode auto",
		"/mode bypass",
		"/clear",
		"exit",
		"quit",
	];
	return commands.filter((c) => c.startsWith(prefix) && c !== prefix);
}

export default function App({
	model,
	daemonClient,
	workDir,
	opts,
	saveSession,
	clearSessions,
	previousSessionContext,
}: AppProps) {
	const [mode, setMode] = useState(opts.mode);
	const [running, setRunning] = useState(false);
	const [isThinking, setIsThinking] = useState(false);
	const [turn, setTurn] = useState(0);
	const [contextUsage, setContextUsage] = useState(0);
	const [currentOutput, setCurrentOutput] = useState("");
	const [streamingText, setStreamingText] = useState("");
	const [sessionLogs, setSessionLogs] = useState<SessionLog[]>([]);
	const [showHelp, setShowHelp] = useState(false);
	const [statusText, setStatusText] = useState("");
	const [threadItems, setThreadItems] = useState<ThreadItem[]>([]);
	const [memoryCount, setMemoryCount] = useState<number | undefined>(undefined);
	const [memoryActivity, setMemoryActivity] = useState<number | undefined>(
		undefined,
	);
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

	// ── Load memory stats on mount ──
	useEffect(() => {
		(async () => {
			try {
				const mm = new MemoryManager(workDir);
				const store = mm.getMemoryStore();
				await store.load();
				const stats = store.getStats();
				if (stats.total > 0) {
					setMemoryCount(stats.total);
					const now = Date.now();
					let recentCount = 0;
					for (const item of store.getAll()) {
						if (now - item.lastAccessedAt < 86_400_000 * 3) recentCount++;
					}
					setMemoryActivity(
						Math.round((recentCount / Math.max(1, stats.total)) * 100),
					);
				}
			} catch {
				// daemon mode — stats loaded via daemon API
			}
		})();
	}, [workDir]);

	// ── Keyboard shortcuts ──
	useInput((_input, key) => {
		if (key.ctrl && key.return) {
			// Ctrl+Enter: force submit (handled by TextInput's onSubmit)
		}
		if (key.escape) {
			setShowHelp(false);
			setStatusText("");
		}
	});

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
					setStatusText(`提交回答失败: ${e?.message || e}`);
				});
			}
		},
		[daemonClient],
	);

	const shouldAutoPromoteToPlan = useCallback((input: string): boolean => {
		const trimmed = input.trim();
		if (trimmed.length < 80) return false;
		const planIntent =
			/(?:请按步骤|分阶段|逐步|按以下步骤|按如下步骤|分步骤|逐步执行|step\s*by\s*step|分多个阶段)/i;
		if (planIntent.test(trimmed)) return true;
		const hasPhaseMark =
			/(?:^|\n)\s*(?:P\d+(?:-\d+)?|Phase\s+\d+|阶段\s*[一二三四五六七八九十\d]+|Step\s+\d+|步骤\s*\d+)\s*[:：.\-、)]/im.test(
				trimmed,
			);
		if (hasPhaseMark && trimmed.length > 120) return true;
		if (trimmed.length > 240) {
			const codeRatio =
				(trimmed.match(/[{}[\]();:=/\\]/g) || []).length / trimmed.length;
			if (codeRatio < 0.08) return true;
		}
		return false;
	}, []);

	const handleSubmit = useCallback(
		async (input: string) => {
			// ── 决策面板待答：自定义回答模式把输入当作回答，而非新任务 ──
			if (
				running &&
				answerMode === "text" &&
				questionsRef.current.some((q) => !q.answer)
			) {
				answerQuestion(input);
				return;
			}

			// ── Built-in commands ──
			if (input === "/help") {
				setShowHelp((v) => !v);
				setStatusText("");
				return;
			}
			if (input === "/status") {
				setStatusText(
					`模式: ${mode} | 模型: ${opts.provider}/${opts.modelName}`,
				);
				setShowHelp(false);
				return;
			}
			if (input.startsWith("/mode ")) {
				const newMode = input.slice(6).trim();
				if (["plan", "default", "trust", "auto", "bypass"].includes(newMode)) {
					setMode(newMode);
					setStatusText(`模式已切换为: ${newMode}`);
				} else {
					setStatusText(
						`未知模式: ${newMode}（可选: plan/default/trust/auto/bypass）`,
					);
				}
				setShowHelp(false);
				return;
			}
			if (input === "/clear") {
				clearSessions?.();
				setStatusText("会话历史已清除");
				setShowHelp(false);
				return;
			}
			if (input === "exit" || input === "quit") {
				process.exit(0);
			}

			// ── Normal query ──
			setShowHelp(false);
			setStatusText("");
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
			lastUserInputRef.current = input;

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
						? `请按以下要求执行此任务：\n\n${input.slice(6).trim()}\n\n要求：\n1. 先制定详细的实施计划，按阶段编号（P0、P1、P2...）或 Step N 格式列出每个步骤，每步包含简短标题和说明\n2. 然后逐个步骤执行，每完成一步在输出中标记该步骤完成\n3. 执行过程中遇到问题及时修复并继续\n4. 所有步骤完成后输出总结`
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
						{
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
							onWorkflow: (ev) => {
								switch (ev.type) {
									case "plan_created": {
										const s = (ev.data?.steps || []).map(
											(step: any, i: number) => ({
												id: step.id || `step-${i}`,
												label: step.label || `步骤 ${i + 1}`,
												description: step.description,
												status: "pending" as const,
											}),
										);
										setSteps(s);
										setPlanSummary(ev.data?.summary || "");
										setPlanTotal(s.length);
										break;
									}
									case "step_started":
										setSteps((prev) =>
											prev.map((s) =>
												s.id === ev.stepId
													? { ...s, status: "running" as const }
													: s,
											),
										);
										break;
									case "step_completed":
										setSteps((prev) => {
											let activated = false;
											return prev.map((s) => {
												if (s.id === ev.stepId)
													return { ...s, status: "completed" as const };
												if (!activated && s.status === "pending") {
													activated = true;
													return { ...s, status: "running" as const };
												}
												return s;
											});
										});
										break;
									case "step_failed":
										setSteps((prev) =>
											prev.map((s) =>
												s.id === ev.stepId
													? {
															...s,
															status: "failed" as const,
															error: ev.data?.error,
														}
													: s,
											),
										);
										break;
									case "step_skipped":
										setSteps((prev) =>
											prev.map((s) =>
												s.id === ev.stepId
													? { ...s, status: "skipped" as const }
													: s,
											),
										);
										break;
									case "replanned": {
										const rs = (ev.data?.steps || []).map(
											(step: any, i: number) => ({
												id: step.id || `step-${i}`,
												label: step.label || `步骤 ${i + 1}`,
												description: step.description,
												status: "pending" as const,
											}),
										);
										setSteps(rs);
										setPlanTotal(rs.length);
										break;
									}
									case "plan_completed":
										setSteps((prev) =>
											prev.map((s) =>
												s.status === "running" || s.status === "pending"
													? { ...s, status: "completed" as const }
													: s,
											),
										);
										break;
								}
							},
						},
					);

					setContextUsage(0);
					const output = result.finalAnswer || "";
					setCurrentOutput(output);

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

					const result = await runTaorLoop(contextualInput, {
						model,
						workDir,
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
			model,
			workDir,
			mode,
			opts,
			saveSession,
			clearSessions,
			previousSessionContext,
			answerMode,
			answerQuestion,
		],
	);

	const bannerItems = useRef([0]).current;

	return (
		<>
			<Static items={bannerItems}>
				{(key) => (
					<Box
						key={key}
						flexDirection="column"
						paddingLeft={1}
						marginBottom={1}
					>
						<Banner />
					</Box>
				)}
			</Static>
			<Box flexDirection="column">
				<Box>
					<Text dimColor> │ </Text>
					<StatusLine
						mode={mode}
						provider={opts.provider}
						modelName={opts.modelName}
						turn={turn}
						contextUsage={contextUsage}
						compactLevel={opts.compactLevel ?? 1}
						memoryCount={memoryCount}
						memoryActivity={memoryActivity}
					/>
				</Box>

				<ContextWaterline contextUsage={contextUsage} running={running} />

				{/* 实时进度摘要 */}
				{running && progressSummary && (
					<Box marginLeft={2} marginBottom={1}>
						<Text dimColor>进度: </Text>
						<Text>{progressSummary}</Text>
					</Box>
				)}

				{/* /help panel */}
				{showHelp && (
					<Box marginTop={1} flexDirection="column">
						{HELP_TEXT.split("\n").map((line, i) => (
							<Text key={i}>{line}</Text>
						))}
					</Box>
				)}

				{/* /status or status text */}
				{statusText && !showHelp && (
					<Box marginTop={1}>
						<Text dimColor>{statusText}</Text>
					</Box>
				)}

				{/* Conversation thread — replaces ThinkingPanel + ExecutionPanel + flat output */}
				<ConversationThread
					userInput={lastUserInputRef.current}
					threadItems={threadItems}
					isRunning={running}
					liveState={running ? { isThinking, turn, streamingText } : null}
					finalAnswer={currentOutput}
					steps={steps.length > 0 ? steps : undefined}
					planSummary={planSummary || undefined}
					planTotal={planTotal || undefined}
				/>

				{/* Session history — timeline style */}
				{sessionLogs.length > 0 && (
					<Static items={sessionLogs}>
						{(log, idx) => {
							const columns =
								process.stdout.columns || process.stderr?.columns || 80;
							// 前缀 "  │ " 视觉宽度 = 4 (2空格 + │双宽)
							const contentMax = columns - 4;
							// 先按 \n 分割，再对每行进行视觉宽度换行
							const rawLines = log.output.split("\n");
							const shouldTrunc = visualLen(log.output) > 200;
							// 收集所有需要渲染的行：原始行 + 换行后的续行
							const allLines: { raw: string; isFirstOfPara: boolean }[] = [];
							rawLines.forEach((rawLine, lineIdx) => {
								const wrapped = wrapVisual(rawLine, contentMax);
								wrapped.forEach((w, wIdx) => {
									allLines.push({ raw: w, isFirstOfPara: wIdx === 0 });
								});
							});
							const displayLines = shouldTrunc
								? allLines.slice(0, 5)
								: allLines;
							// Dot color = action type
							const dotColor =
								log.toolCallCount === 0
									? colors.success
									: log.toolCallCount > 5
										? colors.vermilion
										: colors.indigo;
							return (
								<Box key={`s${log.id}`} flexDirection="column">
									{/* Timeline continuation spacer between sessions */}
									{idx > 0 && <Text dimColor>{"  │"}</Text>}
									{/* Input line */}
									<Text color={dotColor}> ● {log.input}</Text>
									{/* Output lines - each line has prefix */}
									{displayLines.map(({ raw, isFirstOfPara }, li) => {
										const segs = parseMarkdownLine(raw);
										const prefix = isFirstOfPara ? "  │ " : "  │ ";
										const renderedSegs = segs.map((seg, si) => (
											<Text
												key={si}
												bold={seg.bold}
												dimColor={seg.dim}
												color={seg.color as any}
												strikethrough={seg.strikethrough}
											>
												{seg.text}
											</Text>
										));
										return (
											<Box key={`o${li}`} flexDirection="row">
												<Text dimColor>{prefix}</Text>
												{renderedSegs}
											</Box>
										);
									})}
									{shouldTrunc && (
										<Text dimColor>{"  │ （完整输出↑ 对话区域）"}</Text>
									)}
									<Text
										dimColor
									>{`  │ ${log.turnCount} 轮 · ${log.toolCallCount} 工具`}</Text>
								</Box>
							);
						}}
					</Static>
				)}

				{/* ask_user 决策面板 */}
				<QuestionDialog
					questions={questions}
					turn={turn}
					progressSummary={progressSummary}
					inputMode={answerMode || "menu"}
					onSelectAnswer={answerQuestion}
					onSelectCustom={() => setAnswerMode("text")}
					onCancelCustom={() => setAnswerMode("menu")}
				/>

				{/* Input */}
				<InputBar
					onSubmit={handleSubmit}
					disabled={running && answerMode !== "text"}
					answerMode={answerMode}
				/>
			</Box>
		</>
	);
}
