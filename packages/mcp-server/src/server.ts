/**
 * MCPServer — MCP 协议核心实现
 *
 * 职责：
 * 1. 协议握手 (initialize / initialized)
 * 2. JSON-RPC 请求路由到对应处理方法
 * 3. 与会话管理
 * 4. 通过 ToolRegistry 桥接 ToolManager
 *
 * 传输层由外部提供（SSE / Stdio），通过 MCPTransport 接口注入。
 */

import fs from "node:fs";
import type { ToolManager } from "@xuancode/tools";
import { MCPToolRegistry } from "./toolRegistry.js";
import {
	type JSONRPCNotification,
	type JSONRPCRequest,
	type JSONRPCResponse,
	MCPErrorCodes,
	type MCPInitializeParams,
	type MCPInitializeResult,
	MCPMethods,
	type MCPPrompt,
	type MCPResource,
	type MCPResourceTemplate,
	type MCPSession,
	type MCPTool,
	type MCPToolCallResult,
	type MCPTransport,
	MCP_PROTOCOL_VERSION,
} from "./types.js";

export interface MCPServerOptions {
	/** 服务器名称，默认 "xuancode-daemon" */
	serverName?: string;
	/** 服务器版本，默认 "0.1.0" */
	serverVersion?: string;
	/** 是否启用 resource 功能（读取工作区文件），默认 false */
	enableResources?: boolean;
	/** 是否启用 prompt 功能，默认 false */
	enablePrompts?: boolean;
	/** 工作目录（用于 resources），默认 process.cwd() */
	workDir?: string;
}

export class MCPServer {
	private sessions = new Map<string, MCPSession>();
	private toolManager: ToolManager;
	private options: Required<MCPServerOptions>;

	constructor(toolManager: ToolManager, options: MCPServerOptions = {}) {
		this.toolManager = toolManager;
		this.options = {
			serverName: "xuancode-daemon",
			serverVersion: "0.1.0",
			enableResources: false,
			enablePrompts: false,
			workDir: process.cwd(),
			...options,
		};
	}

	/** 注册新的传输连接，返回 session ID */
	createSession(transport: MCPTransport): string {
		const id = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const session: MCPSession = {
			id,
			transport,
			initialized: false,
			createdAt: Date.now(),
		};

		transport.onMessage = (msg) => this.handleMessage(session, msg);
		this.sessions.set(id, session);
		return id;
	}

	/** 移除会话 */
	removeSession(id: string): void {
		const session = this.sessions.get(id);
		if (session) {
			session.transport.close();
			this.sessions.delete(id);
		}
	}

	/** 获取会话数 */
	get sessionCount(): number {
		return this.sessions.size;
	}

	// ===== 消息路由 =====

	private handleMessage(
		session: MCPSession,
		msg: JSONRPCRequest | JSONRPCNotification,
	): void {
		// Notification 没有 id，无需响应
		const isNotification = !("id" in msg) || msg.id === undefined;

		try {
			switch (msg.method) {
				case MCPMethods.Initialize:
					this.handleInitialize(session, msg as JSONRPCRequest);
					break;
				case MCPMethods.Initialized:
					// 纯 notification，无需回复
					break;
				case MCPMethods.Ping:
					this.sendResult(session, msg as JSONRPCRequest, {});
					break;
				case MCPMethods.ToolsList:
					this.handleToolsList(session, msg as JSONRPCRequest);
					break;
				case MCPMethods.ToolsCall:
					this.handleToolsCall(session, msg as JSONRPCRequest);
					break;
				case MCPMethods.ResourcesList:
					this.handleResourcesList(session, msg as JSONRPCRequest);
					break;
				case MCPMethods.ResourcesRead:
					this.handleResourcesRead(session, msg as JSONRPCRequest);
					break;
				case MCPMethods.PromptsList:
					this.handlePromptsList(session, msg as JSONRPCRequest);
					break;
				case MCPMethods.PromptsGet:
					this.handlePromptsGet(session, msg as JSONRPCRequest);
					break;
				default:
					if (!isNotification) {
						this.sendError(
							session,
							msg as JSONRPCRequest,
							MCPErrorCodes.MethodNotFound,
							`未知方法: ${msg.method}`,
						);
					}
			}
		} catch (err: any) {
			if (!isNotification) {
				this.sendError(
					session,
					msg as JSONRPCRequest,
					MCPErrorCodes.InternalError,
					err.message || "Internal error",
				);
			}
		}
	}

	// ===== Initialize =====

	private handleInitialize(session: MCPSession, req: JSONRPCRequest): void {
		const params = req.params as MCPInitializeParams | undefined;
		if (params) {
			session.clientInfo = params.clientInfo;
			session.capabilities = params.capabilities;
		}

		session.initialized = true;

		const caps: Record<string, unknown> = {
			tools: {},
		};
		if (this.options.enableResources) caps.resources = {};
		if (this.options.enablePrompts) caps.prompts = {};

		const result: MCPInitializeResult = {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: caps,
			serverInfo: {
				name: this.options.serverName,
				version: this.options.serverVersion,
			},
		};

		this.sendResult(session, req, result);
	}

	// ===== Tools =====

	private handleToolsList(session: MCPSession, req: JSONRPCRequest): void {
		if (!session.initialized) {
			this.sendError(
				session,
				req,
				MCPErrorCodes.InvalidRequest,
				"Server not initialized",
			);
			return;
		}
		const tools: MCPTool[] = MCPToolRegistry.listTools(this.toolManager);
		this.sendResult(session, req, { tools });
	}

	private async handleToolsCall(
		session: MCPSession,
		req: JSONRPCRequest,
	): Promise<void> {
		if (!session.initialized) {
			this.sendError(
				session,
				req,
				MCPErrorCodes.InvalidRequest,
				"Server not initialized",
			);
			return;
		}

		const params = req.params as
			| { name?: string; arguments?: Record<string, unknown> }
			| undefined;
		if (!params?.name) {
			this.sendError(
				session,
				req,
				MCPErrorCodes.InvalidParams,
				"Missing tool name",
			);
			return;
		}

		const result: MCPToolCallResult = await MCPToolRegistry.callTool(
			this.toolManager,
			params.name,
			params.arguments,
		);

		this.sendResult(session, req, result);
	}

	// ===== Resources =====

	private handleResourcesList(session: MCPSession, req: JSONRPCRequest): void {
		if (!session.initialized) {
			this.sendError(
				session,
				req,
				MCPErrorCodes.InvalidRequest,
				"Server not initialized",
			);
			return;
		}

		const resources: MCPResource[] = [];
		const resourceTemplates: MCPResourceTemplate[] = [];

		if (this.options.enableResources) {
			resourceTemplates.push({
				uriTemplate: "file:///{path}",
				name: "工作区文件",
				description: "通过文件路径读取工作区中的文件",
			});

			// 列出工具定义作为资源
			const tools = MCPToolRegistry.listTools(this.toolManager);
			for (const tool of tools) {
				resources.push({
					uri: `tool:///${tool.name}`,
					name: `工具: ${tool.name}`,
					description: tool.description,
					mimeType: "application/json",
				});
			}
		}

		this.sendResult(session, req, { resources, resourceTemplates });
	}

	private handleResourcesRead(session: MCPSession, req: JSONRPCRequest): void {
		if (!session.initialized) {
			this.sendError(
				session,
				req,
				MCPErrorCodes.InvalidRequest,
				"Server not initialized",
			);
			return;
		}

		const params = req.params as { uri?: string } | undefined;
		if (!params?.uri) {
			this.sendError(
				session,
				req,
				MCPErrorCodes.InvalidParams,
				"Missing resource URI",
			);
			return;
		}

		const uri = params.uri;

		// tool:/// 协议 — 返回工具定义
		if (uri.startsWith("tool:///")) {
			const toolName = uri.slice("tool:///".length);
			const def = this.toolManager.getDefinition(toolName);
			if (!def) {
				this.sendError(
					session,
					req,
					MCPErrorCodes.ResourceNotFound,
					`Tool not found: ${toolName}`,
				);
				return;
			}
			this.sendResult(session, req, {
				contents: [
					{
						uri,
						mimeType: "application/json",
						text: JSON.stringify(def, null, 2),
					},
				],
			});
			return;
		}

		// file:/// 协议 — 读取文件
		if (uri.startsWith("file:///") && this.options.enableResources) {
			const filePath = uri.slice("file:///".length);
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				this.sendResult(session, req, {
					contents: [
						{
							uri,
							mimeType: "text/plain",
							text: content,
						},
					],
				});
			} catch (err: any) {
				this.sendError(
					session,
					req,
					MCPErrorCodes.ResourceNotFound,
					err.message,
				);
			}
			return;
		}

		this.sendError(
			session,
			req,
			MCPErrorCodes.ResourceNotFound,
			`Resource not found: ${uri}`,
		);
	}

	// ===== Prompts =====

	private handlePromptsList(session: MCPSession, req: JSONRPCRequest): void {
		if (!session.initialized) {
			this.sendError(
				session,
				req,
				MCPErrorCodes.InvalidRequest,
				"Server not initialized",
			);
			return;
		}

		const prompts: MCPPrompt[] = [
			{
				name: "agent-config",
				description: "当前 Agent 配置信息",
				arguments: [
					{
						name: "format",
						description: "输出格式: text/json",
						required: false,
					},
				],
			},
		];

		this.sendResult(session, req, { prompts });
	}

	private handlePromptsGet(session: MCPSession, req: JSONRPCRequest): void {
		if (!session.initialized) {
			this.sendError(
				session,
				req,
				MCPErrorCodes.InvalidRequest,
				"Server not initialized",
			);
			return;
		}

		const params = req.params as
			| { name?: string; arguments?: Record<string, string> }
			| undefined;
		if (!params?.name) {
			this.sendError(
				session,
				req,
				MCPErrorCodes.InvalidParams,
				"Missing prompt name",
			);
			return;
		}

		const tools = MCPToolRegistry.listTools(this.toolManager);
		const toolList = tools
			.map((t) => `- ${t.name}: ${t.description || "无描述"}`)
			.join("\n");

		const text = `你正在通过 MCP 协议连接到玄码 (XuanCode) AI Agent。

当前可用的工具:
${toolList}

你可以通过 tools/call 调用这些工具。使用 \`read_file\` 查看代码，\`grep\` 搜索文本，\`shell\` 执行命令等。`;

		this.sendResult(session, req, {
			messages: [
				{ role: "user", content: { type: "text", text: "获取提示词" } },
				{ role: "assistant", content: { type: "text", text } },
			],
		});
	}

	// ===== 响应发送 =====

	private sendResult(
		session: MCPSession,
		req: JSONRPCRequest,
		result: unknown,
	): void {
		session.transport.sendResponse(req.id, result);
	}

	private sendError(
		session: MCPSession,
		req: JSONRPCRequest,
		code: number,
		message: string,
		data?: unknown,
	): void {
		session.transport.sendError(req.id, code, message, data);
	}
}
