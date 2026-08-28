/**
 * MCP (Model Context Protocol) 服务端类型定义
 *
 * 遵循 MCP 协议 2024-11-05 版本：
 * - 传输层: JSON-RPC 2.0 over SSE（HTTP）或 stdio
 * - 核心方法: initialize, tools/list, tools/call, resources/*, prompts/*
 */

// ===== JSON-RPC 2.0 基础 =====

export interface JSONRPCRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result?: unknown;
	error?: JSONRPCError;
}

export interface JSONRPCNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JSONRPCError {
	code: number;
	message: string;
	data?: unknown;
}

// ===== MCP 协议常量 =====

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const MCPErrorCodes = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
	// MCP 自定义错误码（-32000 以上）
	ToolExecutionError: -32000,
	ResourceNotFound: -32001,
	PromptNotFound: -32002,
} as const;

// ===== MCP 方法名 =====

export const MCPMethods = {
	Initialize: "initialize",
	Initialized: "notifications/initialized",
	Ping: "ping",
	ToolsList: "tools/list",
	ToolsCall: "tools/call",
	ResourcesList: "resources/list",
	ResourcesRead: "resources/read",
	PromptsList: "prompts/list",
	PromptsGet: "prompts/get",
} as const;

// ===== 消息体类型 =====

/** 服务器能力声明 */
export interface MCPServerCapabilities {
	tools?: Record<string, unknown>;
	resources?: Record<string, unknown>;
	prompts?: Record<string, unknown>;
	logging?: Record<string, unknown>;
}

/** Initialize 请求参数 */
export interface MCPInitializeParams {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	clientInfo: { name: string; version: string };
}

/** Initialize 结果 */
export interface MCPInitializeResult {
	protocolVersion: string;
	capabilities: MCPServerCapabilities;
	serverInfo: { name: string; version: string };
}

// ===== 工具相关类型 =====

/** MCP 工具定义 — 从 @xuancode/types 的 ToolDefinition 映射而来 */
export interface MCPTool {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, MCPToolProperty>;
		required?: string[];
	};
}

export interface MCPToolProperty {
	type: string;
	description?: string;
	enum?: string[];
}

/** tools/call 参数 */
export interface MCPToolsCallParams {
	name: string;
	arguments?: Record<string, unknown>;
}

/** tools/call 结果内容块 */
export interface MCPTextContent {
	type: "text";
	text: string;
}

export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

export type MCPContentItem = MCPTextContent | MCPResourceContent;

export interface MCPToolCallResult {
	content: MCPContentItem[];
	isError?: boolean;
}

// ===== 资源相关类型 =====

export interface MCPResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

export interface MCPResourceTemplate {
	uriTemplate: string;
	name: string;
	description?: string;
}

/** resources/read 参数 */
export interface MCPResourcesReadParams {
	uri: string;
}

export interface MCPResourceResult {
	contents: Array<{
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	}>;
}

// ===== Prompt 相关类型 =====

export interface MCPPrompt {
	name: string;
	description?: string;
	arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** prompts/get 参数 */
export interface MCPPromptsGetParams {
	name: string;
	arguments?: Record<string, string>;
}

export interface MCPPromptResult {
	description?: string;
	messages: Array<{
		role: "user" | "assistant";
		content: { type: "text"; text: string };
	}>;
}

// ===== 传输层接口 =====

/**
 * MCP 传输层抽象
 *
 * 实现者需要处理消息的收发。
 * SSE 传输: Server → Client 通过 SSE, Client → Server 通过 POST
 * Stdio 传输: 双向通过 stdin/stdout JSON-RPC 行
 */
export interface MCPTransport {
	/** 发送 JSON-RPC 响应到客户端 */
	sendResponse(id: number | string | null, result: unknown): void;
	/** 发送 JSON-RPC 错误到客户端 */
	sendError(
		id: number | string | null,
		code: number,
		message: string,
		data?: unknown,
	): void;
	/** 发送 JSON-RPC 通知（服务端主动推送） */
	sendNotification(method: string, params?: Record<string, unknown>): void;
	/** 收到客户端消息时的回调 */
	onMessage: ((msg: JSONRPCRequest | JSONRPCNotification) => void) | null;
	/** 关闭传输层 */
	close(): void;
}

// ===== 会话管理 =====

export interface MCPSession {
	id: string;
	clientInfo?: { name: string; version: string };
	capabilities?: Record<string, unknown>;
	transport: MCPTransport;
	initialized: boolean;
	createdAt: number;
}
