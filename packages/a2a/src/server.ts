/**
 * A2A HTTP 处理器
 *
 * 在现有 daemon HTTP 服务器上注册 A2A 路由：
 * - GET  /.well-known/agent.json — Agent Card 发现
 * - POST /a2a/tasks — 提交新任务
 * - GET  /a2a/tasks/:id — 获取任务状态
 * - GET  /a2a/tasks/:id/stream — SSE 任务事件流
 */

import type http from "node:http";
import type { Tracer } from "@xuancode/telemetry";
import type { ToolManager } from "@xuancode/tools";
import { generateAgentCard } from "./card.js";
import type {
	AgentCard,
	Task,
	TaskCreateRequest,
	TaskListResponse,
	TaskMessage,
	TaskState,
	TaskStatusEvent,
} from "./types.js";

/** SSE 客户端连接 */
interface SSEClient {
	id: string;
	res: http.ServerResponse;
}

/** A2A 服务器选项 */
export interface A2AServerOptions {
	/** Agent 名称 */
	agentName?: string;
	/** Agent 描述 */
	agentDescription?: string;
	/** 提供方名称 */
	providerName?: string;
	/** 是否支持流式输出 */
	streaming?: boolean;
	/** 任务超时时间（毫秒），默认 5 分钟 */
	taskTimeout?: number;
	/** 可观测性追踪器 */
	tracer?: Tracer;
}

export class A2AServer {
	private toolManager: ToolManager;
	private options: Required<Omit<A2AServerOptions, "tracer">> & {
		tracer?: Tracer;
	};
	private tasks = new Map<string, Task>();
	private sseClients = new Map<string, Set<SSEClient>>();
	private tracer?: Tracer;

	constructor(toolManager: ToolManager, options: A2AServerOptions = {}) {
		this.toolManager = toolManager;
		this.tracer = options.tracer;
		this.options = {
			agentName: "玄码 AI Agent",
			agentDescription: "通用 AI Agent 编排平台",
			providerName: "XuanCode",
			streaming: true,
			taskTimeout: 300_000,
			...options,
		};
	}

	/** 获取 Agent Card */
	getAgentCard(): AgentCard {
		return generateAgentCard(this.toolManager, {
			name: this.options.agentName,
			description: this.options.agentDescription,
			providerName: this.options.providerName,
			streaming: this.options.streaming,
		});
	}

	/** 提交新任务 */
	createTask(request: TaskCreateRequest): Task {
		const id = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const now = new Date().toISOString();

		const task: Task = {
			id,
			state: "pending",
			createdAt: now,
			updatedAt: now,
			input: request.input,
			metadata: request.metadata,
		};

		this.tasks.set(id, task);

		// 异步执行
		this.executeTask(task).catch((err) => {
			task.state = "failed";
			task.error = { code: 500, message: err.message };
			task.updatedAt = new Date().toISOString();
			this.broadcastEvent(task.id, {
				id: task.id,
				state: "failed",
				error: { code: 500, message: err.message },
				timestamp: task.updatedAt,
			});
		});

		return task;
	}

	/** 获取任务 */
	getTask(id: string): Task | undefined {
		return this.tasks.get(id);
	}

	/** 列出任务 */
	listTasks(limit = 20): TaskListResponse {
		const all = Array.from(this.tasks.values())
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, limit);
		return { tasks: all };
	}

	// ===== SSE 流 =====

	/** 注册 SSE 客户端 */
	addSSEClient(taskId: string, client: SSEClient): void {
		if (!this.sseClients.has(taskId)) {
			this.sseClients.set(taskId, new Set());
		}
		this.sseClients.get(taskId)?.add(client);

		// 断开时自动清理
		client.res.on("close", () => {
			this.sseClients.get(taskId)?.delete(client);
		});
	}

	/** 广播任务事件到所有监听该任务的 SSE 客户端 */
	private broadcastEvent(taskId: string, event: TaskStatusEvent): void {
		const clients = this.sseClients.get(taskId);
		if (!clients) return;

		const data = JSON.stringify(event);
		for (const client of clients) {
			try {
				client.res.write(`event: task_update\ndata: ${data}\n\n`);
			} catch {
				clients.delete(client);
			}
		}
	}

	// ===== 任务执行 =====

	private async executeTask(task: Task): Promise<void> {
		task.state = "working";
		task.updatedAt = new Date().toISOString();
		this.broadcastEvent(task.id, {
			id: task.id,
			state: "working",
			timestamp: task.updatedAt,
		});

		// Telemetry: A2A task span
		const a2aSpanId = this.tracer?.startSpan(
			`a2a:${task.id}`,
			"a2a_call",
			"water",
			null,
		)?.id;

		// 从输入中提取文本
		const textInput = task.input?.parts?.find((p) => p.type === "text") as
			| { text?: string }
			| undefined;
		const prompt = textInput?.text || "";

		// 解析工具调用格式：tool_name(param=value, ...)
		// A2A 目前只支持直接工具调用，不做完整 Agent 循环
		const toolMatch = prompt.match(/^(\w+)\((.*)\)$/s);
		if (toolMatch) {
			const toolName = toolMatch[1];
			const argsStr = toolMatch[2];

			// 解析简单 key=value 或 JSON 参数
			let args: Record<string, unknown> = {};
			try {
				args = argsStr ? JSON.parse(`{${argsStr}}`) : {};
			} catch {
				args = { args: argsStr };
			}

			// Telemetry: sub-span for the tool dispatch
			const dispatchSpanId = this.tracer?.startSpan(
				`a2a:dispatch:${toolName}`,
				"a2a_call",
				"water",
				a2aSpanId,
			)?.id;
			const result = await this.toolManager.dispatch({
				type: toolName,
				...args,
			} as any);
			this.tracer?.endSpan(dispatchSpanId!, result.success ? "ok" : "error", {
				error: result.error,
			});

			const outputParts = [];
			if (result.data) {
				outputParts.push({ type: "text" as const, text: result.data });
			}
			if (result.error) {
				outputParts.push({
					type: "text" as const,
					text: `错误: ${result.error}`,
				});
			}

			const output: TaskMessage = {
				role: "agent",
				parts: outputParts,
			};

			task.state = result.success ? "completed" : "failed";
			task.output = output;
			task.updatedAt = new Date().toISOString();

			if (!result.success) {
				task.error = { code: 400, message: result.error || "工具调用失败" };
			}

			this.broadcastEvent(task.id, {
				id: task.id,
				state: task.state,
				output,
				timestamp: task.updatedAt,
			});
		} else {
			// 非工具调用格式，简单返回提示
			const output: TaskMessage = {
				role: "agent",
				parts: [
					{
						type: "text",
						text: `已收到任务。使用格式 "toolName(param=value)" 调用工具。\n可用工具: ${this.toolManager
							.getDefinitions()
							.map((d) => d.name)
							.join(", ")}`,
					},
				],
			};

			task.state = "completed";
			task.output = output;
			task.updatedAt = new Date().toISOString();

			this.broadcastEvent(task.id, {
				id: task.id,
				state: "completed",
				output,
				timestamp: task.updatedAt,
			});
		}

		this.tracer?.endSpan(
			a2aSpanId!,
			task.state === "failed" ? "error" : "ok",
			{},
		);
	}

	// ===== HTTP 路由处理 =====

	/**
	 * 处理 A2A HTTP 请求。
	 * 返回 true 表示已处理，false 表示非 A2A 路由。
	 */
	handleRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
		const url = new URL(
			req.url || "/",
			`http://${req.headers.host || "localhost"}`,
		);
		const method = req.method || "GET";

		// GET /.well-known/agent.json — Agent Card 发现
		if (method === "GET" && url.pathname === "/.well-known/agent.json") {
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			});
			res.end(JSON.stringify(this.getAgentCard(), null, 2));
			return true;
		}

		// POST /a2a/tasks — 提交任务
		if (method === "POST" && url.pathname === "/a2a/tasks") {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				try {
					const request: TaskCreateRequest = JSON.parse(body);
					const task = this.createTask(request);
					res.writeHead(201, {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
					});
					res.end(JSON.stringify(task));
				} catch (err: any) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err.message }));
				}
			});
			return true;
		}

		// GET /a2a/tasks — 列出任务
		if (method === "GET" && url.pathname === "/a2a/tasks") {
			const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
			const result = this.listTasks(limit);
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			});
			res.end(JSON.stringify(result));
			return true;
		}

		// GET /a2a/tasks/:id — 获取任务
		const taskMatch = url.pathname.match(/^\/a2a\/tasks\/([^/]+)$/);
		if (method === "GET" && taskMatch) {
			const taskId = taskMatch[1];
			const task = this.getTask(taskId);
			if (!task) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Task not found" }));
				return true;
			}
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			});
			res.end(JSON.stringify(task));
			return true;
		}

		// GET /a2a/tasks/:id/stream — SSE 任务事件流
		const streamMatch = url.pathname.match(/^\/a2a\/tasks\/([^/]+)\/stream$/);
		if (method === "GET" && streamMatch) {
			const taskId = streamMatch[1];
			const task = this.getTask(taskId);

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Access-Control-Allow-Origin": "*",
			});

			// 立即发送当前状态
			if (task) {
				res.write(
					`event: task_update\ndata: ${JSON.stringify({
						id: task.id,
						state: task.state,
						output: task.output,
						error: task.error,
						timestamp: task.updatedAt,
					})}\n\n`,
				);
			} else {
				res.write(
					`event: error\ndata: ${JSON.stringify({ error: "Task not found" })}\n\n`,
				);
				res.end();
				return true;
			}

			// 注册 SSE 客户端以接收后续更新
			this.addSSEClient(taskId, { id: taskId, res });

			// 连接关闭时清理
			req.on("close", () => {
				try {
					res.end();
				} catch {
					/* ignore */
				}
			});

			return true;
		}

		return false; // 非 A2A 路由
	}
}
