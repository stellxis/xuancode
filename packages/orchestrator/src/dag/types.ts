/** DAG 节点状态 */
export type DagNodeStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "skipped";

/** DAG 节点 — 表示一个可独立执行的子任务 */
export interface DagNode {
	id: string;
	label: string;
	instruction: string;
	subAgentType: string;
	dependencies: string[];
	status: DagNodeStatus;
	result?: string;
	error?: string;
	startedAt?: number;
	completedAt?: number;
	attempts: number;
}

/** DAG 有向无环图 */
export interface DagGraphData {
	nodes: DagNode[];
}

/** 分解结果 */
export interface DagDecomposeResult {
	nodes: DagNode[];
	summary: string;
}

/** DAG 执行配置 */
export interface DagExecConfig {
	maxConcurrency: number;
	modelFactory: (type: string) => any;
	workDir: string;
	/** 自定义 scheduler 工厂，默认使用 SubAgentScheduler */
	schedulerFactory?: (
		modelFactory: (type: string) => any,
		workDir: string,
	) => any;
	/** 节点失败最大重试次数（默认 2，0 = 失败即放弃） */
	maxNodeRetries?: number;
	onNodeStart?: (node: DagNode) => void;
	onNodeComplete?: (node: DagNode) => void;
	onNodeError?: (node: DagNode, error: string) => void;
	/** 节点因依赖失败被级联跳过时回调 */
	onNodeSkipped?: (node: DagNode, reason: string) => void;
}

/** DAG 执行结果 */
export interface DagExecResult {
	success: boolean;
	nodeResults: Map<string, string>;
	failedNodes: string[];
	/** 因依赖失败被级联跳过的节点 */
	skippedNodes: string[];
	duration: number;
}

/** 文件快照 — 用于冲突检测 */
export interface FileSnapshot {
	path: string;
	content: string;
	timestamp: number;
}

/** 冲突记录 */
export interface FileConflict {
	filePath: string;
	nodeIds: string[];
	originalContent?: string;
	description: string;
	autoResolved: boolean;
	resolvedContent?: string;
}
