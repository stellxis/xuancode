/**
 * App — 玄码 CLI 交互主界面
 * 命令分发 + 外围渲染；任务执行机制在 useTaskRunner，会话时间线在 SessionTimeline
 */

import { MemoryManager } from "@xuancode/context";
import type { ModelAdapter } from "@xuancode/model-adapter";
import { Box, Static, Text, useInput } from "ink";
import React, { useState, useCallback, useRef, useEffect } from "react";
import type { DaemonClient } from "../daemonClient";
import type { SessionRecord } from "../session";
import Banner from "./Banner";
import ContextWaterline from "./ContextWaterline";
import ConversationThread from "./ConversationThread";
import InputBar from "./InputBar";
import QuestionDialog from "./QuestionDialog";
import SessionTimeline from "./SessionTimeline";
import StatusLine from "./StatusLine";
import { HELP_TEXT } from "./help";
import { useTaskRunner } from "./useTaskRunner";

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

const MODES = ["plan", "default", "trust", "auto", "bypass"];

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
	const [showHelp, setShowHelp] = useState(false);
	const [statusText, setStatusText] = useState("");
	const [memoryCount, setMemoryCount] = useState<number | undefined>(undefined);
	const [memoryActivity, setMemoryActivity] = useState<number | undefined>(
		undefined,
	);

	const runner = useTaskRunner({
		model,
		daemonClient,
		workDir,
		mode,
		opts,
		saveSession,
		previousSessionContext,
		notify: setStatusText,
	});

	// ── Load memory stats on mount + refresh after each task completes ──
	const loadMemoryStats = useCallback(async () => {
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
			// memory layer failure is non-fatal
		}
	}, [workDir]);

	useEffect(() => {
		void loadMemoryStats();
	}, [loadMemoryStats]);

	// 任务落定后刷新（记忆检索会更新 lastAccessedAt，活跃度随之变化）
	const sessionLogCount = runner.sessionLogs.length;
	useEffect(() => {
		if (sessionLogCount > 0) void loadMemoryStats();
	}, [sessionLogCount, loadMemoryStats]);

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

	const handleSubmit = useCallback(
		async (input: string) => {
			// ── 决策面板待答：自定义回答模式把输入当作回答，而非新任务 ──
			if (
				runner.running &&
				runner.answerMode === "text" &&
				runner.questionsRef.current.some((q) => !q.answer)
			) {
				runner.answerQuestion(input);
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
				if (MODES.includes(newMode)) {
					setMode(newMode);
					setStatusText(`模式已切换为: ${newMode}`);
				} else {
					setStatusText(`未知模式: ${newMode}（可选: ${MODES.join("/")}）`);
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
			if (input === "/tasks" || input.startsWith("/tasks ")) {
				setShowHelp(false);
				void runner.handleTasksCommand(input.slice(6).trim());
				return;
			}
			if (input === "exit" || input === "quit") {
				process.exit(0);
			}

			// ── Normal query ──
			setShowHelp(false);
			setStatusText("");
			await runner.runNormal(input);
		},
		[runner, mode, opts, clearSessions],
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
					<Text dimColor>{"  │ "}</Text>
					<StatusLine
						mode={mode}
						provider={opts.provider}
						modelName={opts.modelName}
						turn={runner.turn}
						contextUsage={runner.contextUsage}
						compactLevel={opts.compactLevel ?? 1}
						memoryCount={memoryCount}
						memoryActivity={memoryActivity}
					/>
				</Box>

				<ContextWaterline
					contextUsage={runner.contextUsage}
					running={runner.running}
				/>

				{/* 实时进度摘要 */}
				{runner.running && runner.progressSummary && (
					<Box marginLeft={2} marginBottom={1}>
						<Text dimColor>进度: </Text>
						<Text>{runner.progressSummary}</Text>
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
					userInput={runner.lastUserInput.current}
					threadItems={runner.threadItems}
					isRunning={runner.running}
					liveState={
						runner.running
							? {
									isThinking: runner.isThinking,
									turn: runner.turn,
									streamingText: runner.streamingText,
								}
							: null
					}
					finalAnswer={runner.currentOutput}
					steps={runner.steps.length > 0 ? runner.steps : undefined}
					planSummary={runner.planSummary || undefined}
					planTotal={runner.planTotal || undefined}
				/>

				{/* Session history — timeline style */}
				<SessionTimeline logs={runner.sessionLogs} />

				{/* ask_user 决策面板 */}
				<QuestionDialog
					questions={runner.questions}
					turn={runner.turn}
					progressSummary={runner.progressSummary}
					inputMode={runner.answerMode || "menu"}
					onSelectAnswer={runner.answerQuestion}
					onSelectCustom={() => runner.setAnswerMode("text")}
					onCancelCustom={() => runner.setAnswerMode("menu")}
				/>

				{/* Input */}
				<InputBar
					onSubmit={handleSubmit}
					disabled={runner.running && runner.answerMode !== "text"}
					answerMode={runner.answerMode}
				/>
			</Box>
		</>
	);
}
