import { z } from "zod";

// ===== 工具系统 =====

export enum ToolType {
	// 文件系统 (金)
	READ_FILE = "read_file",
	WRITE_FILE = "write_file",
	LIST_DIR = "list_dir",
	EDIT_FILE = "edit_file",
	// 代码理解 (木)
	GLOB = "glob",
	GREP = "grep",
	SEARCH = "search",
	// 网络/数据 (水)
	WEB_SEARCH = "web_search",
	WEB_FETCH = "web_fetch",
	// 执行 (火)
	SHELL = "shell",
	// 协作 (土)
	AGENT = "agent",
}

/** 工具参数定义 — 用于向模型描述调用方式 */
export interface ToolParameter {
	name: string;
	type: "string" | "number" | "boolean" | "array" | "object";
	description: string;
	required: boolean;
	default?: unknown;
	enumValues?: string[];
}

/** 工具调用示例 — 用于在提示词中展示 */
export interface ToolExample {
	description: string;
	params: Record<string, unknown>;
}

/** 完整工具定义 — Schema 驱动，自动生成提示词 */
export interface ToolDefinition {
	type: string;
	name: string;
	description: string;
	parameters: ToolParameter[];
	examples: ToolExample[];
	alwaysLoad: boolean;
	category: "metal" | "wood" | "water" | "fire" | "earth";
	schema?: z.ZodType<any>;
}

export const ToolCallParamsSchema = z.object({
	type: z.string(),
	/** 原生 Tool Calling 的 tool_call id（文本 <tool_call> 无此字段，用于区分两条路径） */
	id: z.string().optional(),
	path: z.string().optional(),
	content: z.string().optional(),
	command: z.string().optional(),
	pattern: z.string().optional(),
	query: z.string().optional(),
	url: z.string().optional(),
	oldString: z.string().optional(),
	newString: z.string().optional(),
	// Edit tool（LLM 按 ToolDefinition.parameters 声明名产出 snake_case）
	old_string: z.string().optional(),
	new_string: z.string().optional(),
	// 大文件分块读取
	start_line: z.number().optional(),
	end_line: z.number().optional(),
	// 五行权限门注入的已解析绝对路径
	resolvedPath: z.string().optional(),
	// Git tool params
	staged: z.boolean().optional(),
	count: z.number().optional(),
	action: z.string().optional(),
	name: z.string().optional(),
	message: z.string().optional(),
	add_all: z.boolean().optional(),
	remote: z.string().optional(),
	branch: z.string().optional(),
	// Edit tool
	replace_all: z.boolean().optional(),
	// List dir
	dirPath: z.string().optional(),
	// Batch file ops
	paths: z.array(z.string()).optional(),
	// Workflow 工具（plan_workflow / update_step_status / set_memory / parallel_invoke 等）
	summary: z.string().optional(),
	steps: z.array(z.unknown()).optional(),
	stepId: z.string().optional(),
	status: z.string().optional(),
	result: z.unknown().optional(),
	key: z.string().optional(),
	value: z.unknown().optional(),
	newSteps: z.array(z.unknown()).optional(),
	tasks: z.array(z.unknown()).optional(),
	// Shell 命令兼容别名 + 嵌套参数对象（部分输出形状将参数包在 params 内）
	cmd: z.string().optional(),
	params: z.record(z.unknown()).optional(),
});

export type ToolCallParams = z.infer<typeof ToolCallParamsSchema>;

export interface ToolResult {
	success: boolean;
	data: string;
	error?: string;
	duration?: number;
}

// ===== 消息系统 =====

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 多模态附件块 — base64 编码的媒体数据 */
export interface AttachmentBlock {
	type: "image" | "audio" | "file" | "screenshot";
	data: string;
	mimeType: string;
	name?: string;
	size?: number;
}

/** 原生 Tool Calling 的结构化工具调用（OpenAI 兼容 tool_calls 形状） */
export interface NativeToolCall {
	id: string;
	name: string;
	/** JSON 编码的参数串 */
	arguments: string;
}

/** 富结构流式事件：模型流产出的结构化原生工具调用（阵营 B 通道，不进 content 文本） */
export interface ToolCallsStreamEvent {
	type: "tool_calls";
	toolCalls: NativeToolCall[];
}

/** 模型流式产出：普通文本增量(string) 或 结构化工具调用事件 */
export type ModelStreamEvent = string | ToolCallsStreamEvent;

export interface Message {
	role: MessageRole;
	content: string;
	attachments?: AttachmentBlock[];
	name?: string;
	tool_call_id?: string;
	/** 原生 Tool Calling:assistant 消息携带的结构化工具调用(用于按厂商格式回灌) */
	toolCalls?: NativeToolCall[];
}

// ===== Agent 核心 =====

export enum StopReason {
	NO_TOOL_USE = "no_tool_use",
	MAX_TURNS = "max_turns",
	CONTEXT_OVERFLOW = "context_overflow",
	HOOK_STOP = "hook_stop",
	ABORT = "abort",
	ERROR = "error",
	SUCCESS = "success",
	DAG_COMPLETE = "dag_complete",
	WORKFLOW_COMPLETE = "workflow_complete",
	LOOP_DETECTED = "loop_detected",
}

export interface ToolCall {
	type: string;
	path?: string;
	content?: string;
	command?: string;
	pattern?: string;
	args?: Record<string, unknown>;
}

export interface AgentState {
	messages: Message[];
	turnCount: number;
	maxTurns: number;
	startTime: number;
	stopReason?: StopReason;
	finalAnswer?: string;
	error?: Error;
	errorHistory: Array<{ turn: number; message: string; recoverable: boolean }>;
	contextBudget: number;
	maxContextBudget: number;
	lastToolCall?: ToolCall;
	lastToolResult?: ToolResult;
	consecutiveErrors: number;
}

export type AgentMode = "plan" | "default" | "trust" | "auto" | "bypass";

export interface AgentConfig {
	workDir: string;
	mode: AgentMode;
	maxTurns: number;
	modelName: string;
	modelProvider: string;
	systemPrompt?: string;
	/** Context compression level (0-4, default: 1 = SNIP) */
	compactLevel?: CompactLevel;
	/** Context usage ratio that triggers compression (0.0-1.0, default: 0.7) */
	compactThreshold?: number;
	/** 达到 maxTurns 后自动续跑的次数（默认 0 = 不续跑） */
	maxContinuations?: number;
	/** 程序化验证命令（auto/bypass 验证 gate 使用，留空则让 agent 自行选择合适的验证命令） */
	verifyCommand?: string;
	/** 验证 gate 模式: auto = 改码后强制验证通过才能结束; manual = 仅提示不拦截; off = 关闭 */
	verifyMode?: "auto" | "manual" | "off";
	/** 验证失败修复循环的最大拦截轮数（默认 3） */
	maxVerifyRounds?: number;
	/** C2 · 目标闭环开关（需 verifyMode === "auto"）：未达标持续修复，达标/达上限才结束 */
	goalMode?: boolean;
	/** C2 · 验收标准（goalMode 时生效），如「运行 pnpm test 且全部通过」 */
	goalCriterion?: string;
	/** C2 · 目标重试上限轮数（默认 3） */
	goalMaxRounds?: number;
}

// ===== 五行状态 =====

export type ElementType = "metal" | "wood" | "water" | "fire" | "earth";

export interface ElementStatus {
	element: ElementType;
	name: string;
	active: boolean;
	status: "idle" | "running" | "error" | "done";
	duration?: number;
}

// ===== 上下文管理 =====

export enum CompactLevel {
	NONE = 0,
	SNIP = 1,
	MICRO_COMPACT = 2,
	CONTEXT_COLLAPSE = 3,
	AUTO_COMPACT = 4,
}

// ===== 记忆系统 =====

/** 结构化记忆条目 — 用于记忆系统的检索、排序和衰减 */
export interface MemoryItem {
	id: string;
	text: string;
	tags: string[]; // ["preference", "decision", "constraint", "pattern"]
	source?: string; // sessionId 来源
	weight: number; // 0.0 ~ 1.0
	pinned: boolean; // 免衰减
	createdAt: number; // Unix ms
	lastAccessedAt: number;
	accessCount: number;
}

/** 记忆排序选项 */
// ===== 内联代码补全 (Tab Completion) =====

export interface InlineCompletionRequest {
	/** 文件绝对路径 */
	filePath: string;
	/** 当前文件完整内容 */
	content: string;
	/** 光标位置（0-indexed） */
	position: { line: number; column: number };
	/** 语言标识（如 typescript, python） */
	language: string;
	/** 光标前文本（最近 500 字符） */
	contextBefore: string;
	/** 光标后文本（最近 200 字符） */
	contextAfter: string;
}

export interface InlineCompletion {
	/** 补全文本 */
	text: string;
	/** 可选显示文本（替代 text 显示在幽灵文本中） */
	displayText?: string;
	/** 补全项标签 */
	label?: string;
}

export interface InlineCompletionResponse {
	completions: InlineCompletion[];
}

export interface MemoryRankOptions {
	topK: number; // 默认 15
	minScore: number; // 默认 0.05
	decayLambda: number; // 默认 0.01（~100 天半衰期）
}

// ===== 子 Agent =====

export type SubAgentType =
	| "explore"
	| "plan"
	| "implement"
	| "review"
	| "security"
	| "test"
	| "docs"
	| "debug";

// ===== 动态工作流 =====

export enum WorkflowStepStatus {
	PENDING = "pending",
	RUNNING = "running",
	COMPLETED = "completed",
	FAILED = "failed",
	SKIPPED = "skipped",
}

export interface WorkflowStep {
	id: string;
	label: string;
	description: string;
	status: WorkflowStepStatus;
	dependencies: string[];
	subAgentType?: SubAgentType;
	result?: string;
	error?: string;
	startedAt?: number;
	completedAt?: number;
}

export interface WorkflowPlan {
	id: string;
	summary: string;
	steps: WorkflowStep[];
	currentStepId: string | null;
	context: Record<string, string>;
	createdAt: number;
	updatedAt: number;
}

export interface WorkflowEvent {
	type:
		| "plan_created"
		| "step_started"
		| "step_completed"
		| "step_failed"
		| "step_skipped"
		| "plan_completed"
		| "branch_applied"
		| "replanned";
	planId: string;
	stepId?: string;
	timestamp: number;
	data?: Record<string, unknown>;
}

export interface SubAgentConfig {
	type: SubAgentType;
	model?: string;
	instructions: string;
	isolation?: "none" | "worktree" | "remote";
}

/** 自动审查结果 */
export interface ReviewResult {
	taskId: string;
	summary: string;
	severity: "critical" | "warning" | "info";
	findings: Array<{ severity: string; message: string; location?: string }>;
	passed: boolean;
	completedAt: number;
}

// ===== Hook 事件 =====

export enum HookEvent {
	PRE_TOOL_USE = "PreToolUse",
	POST_TOOL_USE = "PostToolUse",
	POST_TOOL_USE_FAILURE = "PostToolUseFailure",
	SESSION_START = "SessionStart",
	SESSION_END = "SessionEnd",
	SUBAGENT_START = "SubagentStart",
	SUBAGENT_STOP = "SubagentStop",
	PRE_COMPACT = "PreCompact",
	POST_COMPACT = "PostCompact",
	PERMISSION_REQUEST = "PermissionRequest",
	PERMISSION_DENIED = "PermissionDenied",
	TASK_COMPLETE = "TaskComplete",
}
