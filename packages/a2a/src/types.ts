/**
 * A2A (Agent-to-Agent) 协议类型定义
 *
 * 遵循 Google Agent-to-Agent 协议规范（简化实现）。
 * 用于 Agent 之间发现能力、提交任务、获取结果。
 */

// ===== Agent Card（能力广播） =====

/** Agent 元信息 */
export interface AgentCard {
	/** 协议版本 */
	version: "1.0";
	/** Agent 名称 */
	name: string;
	/** Agent 描述 */
	description: string;
	/** 所属方 */
	provider?: { name: string; url?: string };
	/** 能力列表 */
	skills: AgentSkill[];
	/** 认证方式 */
	auth?: { schemes: Array<{ type: string; description?: string }> };
	/** 是否支持流式输出 */
	streaming?: boolean;
}

/** Agent 技能描述 */
export interface AgentSkill {
	/** 技能名称 */
	name: string;
	/** 技能描述 */
	description: string;
	/** 输入参数描述 */
	inputs?: Array<{
		name: string;
		type: string;
		description: string;
		required?: boolean;
	}>;
	/** 输出类型 */
	outputType?: string;
	/** 五行元素分类 */
	element?: "metal" | "wood" | "water" | "fire" | "earth";
}

// ===== Agent Task（任务模型） =====

export type TaskState =
	| "pending"
	| "working"
	| "input_required"
	| "completed"
	| "failed"
	| "canceled";

/** 任务的完整状态 */
export interface Task {
	id: string;
	state: TaskState;
	/** 创建时间 (ISO 8601) */
	createdAt: string;
	/** 最后更新时间 (ISO 8601) */
	updatedAt: string;
	/** 输入消息 */
	input?: TaskMessage;
	/** 输出结果（完成后） */
	output?: TaskMessage;
	/** 错误信息（失败时） */
	error?: { code: number; message: string };
	/** 元数据 */
	metadata?: Record<string, unknown>;
}

/** 任务消息 */
export interface TaskMessage {
	role: "user" | "assistant" | "agent";
	parts: TaskPart[];
}

/** 任务内容块 */
export type TaskPart =
	| { type: "text"; text: string }
	| { type: "file"; mimeType: string; data: string; name?: string }
	| { type: "data"; data: Record<string, unknown> };

// ===== API 请求/响应 =====

/** 创建任务请求 */
export interface TaskCreateRequest {
	/** 任务输入 */
	input: TaskMessage;
	/** 会话 ID（可选，用于跟踪） */
	sessionId?: string;
	/** 元数据 */
	metadata?: Record<string, unknown>;
}

/** 任务列表响应 */
export interface TaskListResponse {
	tasks: Task[];
	nextPageToken?: string;
}

/** 任务状态变更通知（SSE 事件） */
export interface TaskStatusEvent {
	id: string;
	state: TaskState;
	output?: TaskMessage;
	error?: { code: number; message: string };
	timestamp: string;
}
