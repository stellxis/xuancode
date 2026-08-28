/**
 * SSETransport — MCP Over HTTP 传输层实现
 *
 * MCP HTTP 传输规范：
 * - GET /sse — 服务端到客户端的 SSE 连接
 * - POST /message?sessionId=xxx — 客户端到服务端的请求
 *
 * 服务端在 SSE 连接上发送 JSON-RPC 响应和通知，
 * 客户端通过 POST 发送 JSON-RPC 请求。
 */

import type http from "node:http";
import {
	type JSONRPCNotification,
	type JSONRPCRequest,
	MCPErrorCodes,
	type MCPTransport,
} from "./types.js";

/** SSE 传输选项 */
export interface SSETransportOptions {
	/** SSE 连接的 base URL（用于生成 endpoint URL） */
	baseUrl?: string;
}

/**
 * 单个 SSE 连接的传输实例
 *
 * 每个 SSE 连接绑定一个 sessionId，
 * 服务端通过 SSE write 发送消息，
 * 客户端通过 POST /message?sessionId=xxx 发送请求。
 */
export class SSETransport implements MCPTransport {
	onMessage: ((msg: JSONRPCRequest | JSONRPCNotification) => void) | null =
		null;
	private res: http.ServerResponse | null = null;
	private _closed = false;

	/** 客户端 POST 请求的等待队列（如果 SSE 尚未就绪，暂存请求） */
	private pendingMessages: Array<JSONRPCRequest | JSONRPCNotification> = [];

	/** 注册 SSE 响应对象，开始推送 */
	attachSSEResponse(res: http.ServerResponse): void {
		this.res = res;

		// SSE headers
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
		});

		// 发送 endpoint 事件，告诉客户端用哪个 URL 发请求
		// sessionId 由外部在 URL 中携带，这里只发相对路径模板
		const endpointData = JSON.stringify({ endpoint: "/message" });
		res.write(`event: endpoint\ndata: ${endpointData}\n\n`);

		// 处理暂存的请求
		const pending = this.pendingMessages;
		this.pendingMessages = [];
		for (const msg of pending) {
			this.onMessage?.(msg);
		}
	}

	/** 处理客户端 POST 请求（返回 JSON-RPC 响应） */
	handlePOST(body: unknown): JSONRPCRequest | JSONRPCNotification | null {
		const msg = body as JSONRPCRequest | JSONRPCNotification;

		if (!msg || typeof msg !== "object" || !msg.method) {
			// 非法的 JSON-RPC 消息，无法响应（无 id）
			return null;
		}

		// 如果 SSE 尚未连接，暂存
		if (!this.res) {
			this.pendingMessages.push(msg);
			return msg;
		}

		// 直接触发消息处理
		this.onMessage?.(msg);
		return msg;
	}

	// ===== MCPTransport 接口实现 =====

	sendResponse(id: number | string | null, result: unknown): void {
		if (!this.res || this._closed) return;
		const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
		this.res.write(`data: ${msg}\n\n`);
	}

	sendError(
		id: number | string | null,
		code: number,
		message: string,
		data?: unknown,
	): void {
		if (!this.res || this._closed) return;
		const msg = JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: { code, message, data },
		});
		this.res.write(`data: ${msg}\n\n`);
	}

	sendNotification(method: string, params?: Record<string, unknown>): void {
		if (!this.res || this._closed) return;
		const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
		this.res.write(`data: ${msg}\n\n`);
	}

	close(): void {
		this._closed = true;
		if (this.res) {
			try {
				this.res.end();
			} catch {
				/* ignore */
			}
			this.res = null;
		}
	}

	get closed(): boolean {
		return this._closed;
	}
}

/** MCP HTTP 处理器 — 轻量级路由 */
export function createMCPHttpHandler() {
	const sessions = new Map<string, SSETransport>();

	return {
		sessions,

		/**
		 * GET /sse — 建立 SSE 连接
		 * 客户端通过 ?sessionId=xxx 标识自己
		 */
		handleSSE(req: http.IncomingMessage, res: http.ServerResponse): boolean {
			const url = new URL(
				req.url || "/",
				`http://${req.headers.host || "localhost"}`,
			);
			if (url.pathname !== "/sse") return false;

			const sessionId =
				url.searchParams.get("sessionId") ||
				`mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

			// 获取或创建传输
			let transport = sessions.get(sessionId);
			if (!transport) {
				transport = new SSETransport();
				sessions.set(sessionId, transport);

				// SSE 断开时清理
				req.on("close", () => {
					transport?.close();
					sessions.delete(sessionId);
				});
			}

			transport.attachSSEResponse(res);
			return true;
		},

		/**
		 * POST /message — 接收客户端 JSON-RPC 请求
		 */
		handleMessage(
			req: http.IncomingMessage,
			res: http.ServerResponse,
		): boolean {
			const url = new URL(
				req.url || "/",
				`http://${req.headers.host || "localhost"}`,
			);
			if (url.pathname !== "/message") return false;

			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) {
				res.writeHead(400, {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				});
				res.end(JSON.stringify({ error: "Missing sessionId" }));
				return true;
			}

			const transport = sessions.get(sessionId);
			if (!transport) {
				res.writeHead(404, {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				});
				res.end(JSON.stringify({ error: "Session not found" }));
				return true;
			}

			// 收集 body
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				try {
					const parsed = JSON.parse(body);
					transport.handlePOST(parsed);
					// 如果 SSE 已连接，POST 立即返回
					// 实际响应通过 SSE 通道发送
					res.writeHead(202, {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
					});
					res.end(JSON.stringify({ status: "accepted" }));
				} catch (err: any) {
					res.writeHead(400, {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
					});
					res.end(JSON.stringify({ error: err.message }));
				}
			});

			return true;
		},
	};
}
