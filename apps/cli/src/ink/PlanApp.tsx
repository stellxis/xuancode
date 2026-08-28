/**
 * PlanApp — 聚焦的 Ink 应用，渲染多步骤工作流执行进度，完成后自动退出
 */

import { Box, Static, Text } from "ink";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
	type PlanOpts,
	type PlanState,
	submitPlanTask,
} from "../commands/plan";
import type { DaemonClient } from "../daemonClient";
import { colors } from "./theme";

// ===== Spinner =====

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner() {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const timer = setInterval(
			() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
			120,
		);
		return () => clearInterval(timer);
	}, []);
	return <>{SPINNER_FRAMES[frame]}</>;
}

// ===== Step row =====

function getStepIcon(step: PlanState["steps"][number]): {
	icon: React.ReactNode;
	color: string;
} {
	switch (step.status) {
		case "completed":
			return { icon: "☑", color: colors.success };
		case "running":
			return { icon: <Spinner />, color: colors.indigo };
		case "failed":
			return { icon: "✕", color: colors.error };
		case "skipped":
			return { icon: "⊟", color: colors.dim };
		default:
			return { icon: "□", color: colors.dim };
	}
}

function StepRow({ step }: { step: PlanState["steps"][number] }) {
	const { icon, color } = getStepIcon(step);
	return (
		<Box>
			<Text color={color as any}>
				{"  │ "}
				{icon} {step.label}
			</Text>
		</Box>
	);
}

// ===== PlanApp =====

interface PlanAppProps {
	task: string;
	daemonClient?: DaemonClient;
	workDir: string;
	opts: PlanOpts;
}

export default function PlanApp({
	task,
	daemonClient,
	workDir,
	opts,
}: PlanAppProps) {
	const [planState, setPlanState] = useState<PlanState>({
		steps: [],
		summary: "",
		totalSteps: 0,
		completedSteps: 0,
		status: "idle",
	});
	const [streamingText, setStreamingText] = useState("");
	const [finalAnswer, setFinalAnswer] = useState("");
	const [error, setError] = useState("");
	const startedRef = useRef(false);
	const finalAnswerRef = useRef<string>("");

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		const reducer = createPlanStateReducerForPlanApp(setPlanState);

		submitPlanTask(task, daemonClient, workDir, opts, {
			onStateChange: (s) => setPlanState(s),
			onWorkflowEvent: (event) => reducer.handleWorkflowEvent(event),
			onToken: (fullText) => setStreamingText(fullText),
			onError: (err) => {
				setError(err);
				scheduleExit(1);
			},
			onFinalAnswer: (answer) => {
				finalAnswerRef.current = answer;
				setFinalAnswer(answer);
			},
		});
	}, [task, daemonClient, workDir, opts]);

	// Auto-exit on plan completion
	useEffect(() => {
		if (planState.status === "completed") {
			scheduleExit(0);
		}
	}, [planState.status]);

	function scheduleExit(code: number): void {
		setTimeout(() => process.exit(code), 500);
	}

	const progress =
		planState.totalSteps > 0
			? ` (${planState.completedSteps}/${planState.totalSteps})`
			: "";

	return (
		<Box flexDirection="column" paddingLeft={1}>
			{/* Task description header */}
			<Box>
				<Text bold color={colors.indigo}>
					{"  ● "}
					{task}
				</Text>
			</Box>

			{/* Plan summary + progress */}
			{planState.summary && (
				<Box>
					<Text color={colors.gold}>
						{"  · "}
						{planState.summary}
						{progress}
					</Text>
				</Box>
			)}

			{/* Empty progress dot when no steps yet but running */}
			{planState.status === "running" && planState.steps.length === 0 && (
				<Box>
					<Text dimColor>
						{"  │ "}
						<Spinner /> 正在生成执行计划...
					</Text>
				</Box>
			)}

			{/* Step list */}
			{planState.steps.map((step) => (
				<StepRow key={step.id} step={step} />
			))}

			{/* Error */}
			{error && (
				<Box>
					<Text color={colors.error}>
						{"  ✕ "}
						{error}
					</Text>
				</Box>
			)}

			{/* Final answer — rendered as static block to persist after exit */}
			{finalAnswer && (
				<Static items={[finalAnswer]}>
					{(answer) => (
						<Box flexDirection="column" marginTop={1}>
							<Box>
								<Text bold color={colors.thinking}>
									{"  └─ 玄码 执行结果:"}
								</Text>
							</Box>
							{answer.split("\n").map((line, i) => (
								<Box key={i}>
									<Text dimColor>
										{"     "}
										{line}
									</Text>
								</Box>
							))}
						</Box>
					)}
				</Static>
			)}
		</Box>
	);
}

// ===== Inline reducer for PlanApp =====

function createPlanStateReducerForPlanApp(
	setState: React.Dispatch<React.SetStateAction<PlanState>>,
) {
	const state: PlanState = {
		steps: [],
		summary: "",
		totalSteps: 0,
		completedSteps: 0,
		status: "idle",
	};

	function emit(): void {
		setState({ ...state, steps: [...state.steps] });
	}

	return {
		handleWorkflowEvent(event: any): void {
			const ev = event as { type: string; stepId?: string; data?: any };
			switch (ev.type) {
				case "plan_created": {
					const steps = (ev.data?.steps || []).map((s: any, i: number) => ({
						id: s.id || `step-${i}`,
						label: s.label || `Step ${i + 1}`,
						description: s.description,
						status: "pending" as const,
					}));
					state.steps = steps;
					state.summary = ev.data?.summary || "";
					state.totalSteps = steps.length;
					state.completedSteps = 0;
					state.status = "running";
					emit();
					break;
				}
				case "step_started": {
					state.steps = state.steps.map((s) =>
						s.id === ev.stepId ? { ...s, status: "running" as const } : s,
					);
					emit();
					break;
				}
				case "step_completed": {
					state.steps = state.steps.map((s) =>
						s.id === ev.stepId ? { ...s, status: "completed" as const } : s,
					);
					state.completedSteps = state.steps.filter(
						(s) => s.status === "completed",
					).length;
					emit();
					break;
				}
				case "step_failed": {
					state.steps = state.steps.map((s) =>
						s.id === ev.stepId
							? { ...s, status: "failed" as const, error: ev.data?.error }
							: s,
					);
					state.status = "failed";
					emit();
					break;
				}
				case "step_skipped": {
					state.steps = state.steps.map((s) =>
						s.id === ev.stepId ? { ...s, status: "skipped" as const } : s,
					);
					emit();
					break;
				}
				case "replanned": {
					const rs = (ev.data?.steps || []).map((s: any, i: number) => ({
						id: s.id || `step-${i}`,
						label: s.label || `Step ${i + 1}`,
						description: s.description,
						status: "pending" as const,
					}));
					state.steps = rs;
					state.totalSteps = rs.length;
					state.completedSteps = 0;
					emit();
					break;
				}
				case "plan_completed": {
					state.steps = state.steps.map((s) =>
						s.status === "running" || s.status === "pending"
							? { ...s, status: "completed" as const }
							: s,
					);
					state.completedSteps = state.steps.filter(
						(s) => s.status === "completed",
					).length;
					state.status = "completed";
					emit();
					break;
				}
			}
		},
	};
}
