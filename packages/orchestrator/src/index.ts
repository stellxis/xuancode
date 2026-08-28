export {
	runTaorLoop,
	XUANCODE_SYSTEM_PROMPT_BASE as XUANCODE_SYSTEM_PROMPT,
} from "./taorLoop";
export type { TaorLoopOptions, TaorLoopResult } from "./taorLoop";
export {
	parseToolCall,
	extractJsonBlocks,
	stripThinkContent,
	stripToolCalls,
	hasToolCall,
} from "./toolParser";
export {
	checkStopConditions,
	STOP_CONDITIONS,
	createBudgetCheck,
} from "./stopConditions";
export type { StopCondition } from "./stopConditions";
export { StateManager } from "./stateManager";
export { getRecovery, isRecoverable, ContinueSite } from "./errorRecovery";
export type { RecoveryAction } from "./errorRecovery";
export { StreamingToolExecutor } from "./streamExecutor";

// ===== Phase 3: DAG 拓扑调度 =====
export {
	DagGraph,
	DagExecutor,
	decomposeWithLLM,
	shouldDecompose,
	validateDag,
	recommendMode,
	shouldUseDagScheduling,
} from "./dag";
export type {
	DagNode,
	DagNodeStatus,
	DagGraphData,
	DagDecomposeResult,
	DagExecConfig,
	DagExecResult,
	FileSnapshot,
	FileConflict,
	ModePreset,
	ModeRecommendation,
} from "./dag";

// ===== 动态工作流 =====
export {
	WorkflowPlanManager,
	createWorkflowToolDefinitions,
	seedFromDag,
	syncToDagStatuses,
} from "./workflow";
export type {
	WorkflowPlanManagerOptions,
	WorkflowToolRegistration,
} from "./workflow";

// ===== P0/P1: 验证 gate + 项目 checkpoint + 编译输出截断 =====
export {
	isVerifyCommand,
	extractVerifyErrors,
	evaluateVerifyGate,
	truncateCompileOutput,
} from "./verify";
export type { VerifyGateDecision } from "./verify";
export {
	ProjectCheckpoint,
	formatCheckpointSnapshot,
	loadCheckpointContext,
	writeResumeState,
	readResumeState,
	clearResumeState,
} from "./projectCheckpoint";
export type {
	CheckpointVerifyState,
	ProjectCheckpointSnapshot,
	CheckpointPlanStep,
	ResumeState,
} from "./projectCheckpoint";
