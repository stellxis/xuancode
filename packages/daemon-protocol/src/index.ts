/**
 * 玄码 daemon HTTP 线协议契约（CLI / VSCode / Desktop 三端共用单点）
 * 纯常量 + 纯类型，零运行时依赖，可被任意端 bundle。
 */

export const PROTOCOL_NAME = "xuancode-daemon";

/** 协议版本号：仅破坏性变更（改字段语义 / 删路径）时 +1；加字段 / 加路径不变 */
export const API_VERSION = 1;

/** 客户端通过该 header 声明自己实现的协议版本 */
export const API_VERSION_HEADER = "X-XC-Api-Version";

/** 本实现支持的最低协议版本 */
export const MIN_SUPPORTED_API_VERSION = 1;

export interface VersionInfo {
	protocol: string;
	apiVersion: number;
	daemonVersion: string;
	features: string[];
}

export interface ErrorBody {
	error: string;
	code?: string;
	serverApiVersion?: number;
	minClientApiVersion?: number;
}

// ===== 线协议契约（SSE + 任务） =====
// 单一来源：daemon 发出 → CLI/VSCode/Desktop 消费，schema 供契约一致性测试。

import { z } from "zod";

/** SSE 事件名全集（daemon taskEventBus.publish 事件名） */
export const SSEEventType = z.enum([
	"connected",
	"turn",
	"token",
	"tool_call",
	"reasoning",
	"error",
	"complete",
	"error_fatal",
	"progress",
	"ask_user",
	"input_received",
	"permission_request",
	"workflow",
	"verify",
	"file_changed",
	"checkpoint",
	"review_decision",
	"telemetry_span",
	"workspace",
]);
export type SSEEventType = z.infer<typeof SSEEventType>;

// ===== WorkflowEvent =====
// 以 packages/types 的 server 侧 WorkflowEvent 为权威；data 保留开放 catchall，
// 兼容各端对 label/summary/steps/result/error 的消费。
export const WorkflowEventType = z.enum([
	"plan_created",
	"step_started",
	"step_completed",
	"step_failed",
	"step_skipped",
	"plan_completed",
	"branch_applied",
	"replanned",
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventType>;

export const WorkflowEventDataSchema = z
	.object({
		label: z.string().optional(),
		summary: z.string().optional(),
		steps: z.array(z.record(z.string(), z.unknown())).optional(),
		result: z.string().optional(),
		error: z.string().optional(),
	})
	.catchall(z.unknown());

export const WorkflowEventSchema = z.object({
	type: WorkflowEventType,
	planId: z.string(),
	stepId: z.string().optional(),
	timestamp: z.number(),
	data: WorkflowEventDataSchema.optional(),
});
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
export type WorkflowEventData = z.infer<typeof WorkflowEventDataSchema>;

// ===== TaskResult（SSE complete 事件 payload） =====
export const TaskResultSchema = z.object({
	finalAnswer: z.string(),
	turnCount: z.number(),
	toolCallCount: z.number(),
	stopReason: z.string(),
	duration: z.number(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

// ===== 各 SSE 事件 payload =====

export const TokenPayloadSchema = z.object({
	token: z.string(),
	fullText: z.string().optional(),
});
export type TokenPayload = z.infer<typeof TokenPayloadSchema>;

export const TurnPayloadSchema = z
	.object({
		turn: z.number(),
		contextUsage: z.number().optional(),
		message: z.string().optional(),
		dagNode: z.string().optional(),
		dagNodeLabel: z.string().optional(),
		dagMessage: z.string().optional(),
		dagStatus: z.string().optional(),
	})
	.catchall(z.unknown());
export type TurnPayload = z.infer<typeof TurnPayloadSchema>;

export const ToolCallPayloadSchema = z
	.object({
		toolType: z.string(),
		params: z.record(z.string(), z.unknown()),
		result: z
			.object({
				success: z.boolean(),
				error: z.string().optional(),
				output: z.string().optional(),
			})
			.catchall(z.unknown()),
	})
	.catchall(z.unknown());
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;

export const ErrorPayloadSchema = z.object({
	message: z.string(),
	site: z.string().optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export const ErrorFatalPayloadSchema = z.object({
	error: z.string(),
});
export type ErrorFatalPayload = z.infer<typeof ErrorFatalPayloadSchema>;

export const ProgressPayloadSchema = z.object({
	turn: z.number(),
	summary: z.string(),
	toolCallCount: z.number(),
});
export type ProgressPayload = z.infer<typeof ProgressPayloadSchema>;

export const AskUserPayloadSchema = z.object({
	question: z.string(),
	options: z.array(z.string()).optional(),
	correlationId: z.string().optional(),
});
export type AskUserPayload = z.infer<typeof AskUserPayloadSchema>;

export const InputReceivedPayloadSchema = z.object({
	answer: z.string(),
});
export type InputReceivedPayload = z.infer<typeof InputReceivedPayloadSchema>;

export const PermissionRequestPayloadSchema = z
	.object({
		requestId: z.string(),
		toolType: z.string(),
		params: z.record(z.string(), z.unknown()),
		reason: z.string().optional(),
		risk: z.record(z.string(), z.unknown()).optional(),
	})
	.catchall(z.unknown());
export type PermissionRequestPayload = z.infer<
	typeof PermissionRequestPayloadSchema
>;
