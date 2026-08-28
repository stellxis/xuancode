/**
 * MCP (Model Context Protocol) Client
 *
 * 桥接 MCP 生态，使任意 MCP 工具可直接作为玄码工具使用。
 * 支持 stdio 和 HTTP/SSE 两种传输方式。
 *
 * 使用示例:
 * ```
 * const client = new MCPClient(new StdioTransport("npx", ["@modelcontextprotocol/server-github"]));
 * await client.connect();
 * const tools = await client.listTools();
 * const result = await client.callTool("create_issue", { title: "bug", body: "..." });
 * ```
 */

// ===== JSON-RPC 基础 =====

interface JSONRPCRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

interface JSONRPCResponse {
	jsonrpc: "2.0";
	id: number;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

// ===== MCP 工具定义 =====

export interface MCPToolDefinition {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, { type: string; description?: string }>;
		required?: string[];
	};
}

export interface MCPCallResult {
	content: Array<{ type: "text" | "resource"; text?: string; resource?: any }>;
	isError?: boolean;
}

// ===== 传输层接口 =====

export interface MCPTransport {
	connect(): Promise<void>;
	send(message: JSONRPCRequest): Promise<JSONRPCResponse>;
	close(): Promise<void>;
}

// ===== Stdio 传输 =====

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class StdioTransport implements MCPTransport {
	private proc: ChildProcess | null = null;
	private pending = new Map<
		number,
		{ resolve: (v: JSONRPCResponse) => void; reject: (e: Error) => void }
	>();
	private nextId = 1;
	private buffer = "";

	constructor(
		private command: string,
		private args: string[] = [],
		private options?: { cwd?: string; env?: Record<string, string> },
	) {}

	async connect(): Promise<void> {
		this.proc = spawn(this.command, this.args, {
			cwd: this.options?.cwd,
			env: { ...process.env, ...this.options?.env },
			stdio: ["pipe", "pipe", "inherit"],
			windowsHide: true,
		});

		const rl = createInterface({
			input: this.proc.stdout!,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		rl.on("line", (line) => {
			try {
				const response: JSONRPCResponse = JSON.parse(line);
				const pending = this.pending.get(response.id);
				if (pending) {
					this.pending.delete(response.id);
					pending.resolve(response);
				}
			} catch {
				/* ignore malformed lines */
			}
		});

		this.proc.on("exit", (code) => {
			// Reject all pending requests
			for (const [, pending] of this.pending) {
				pending.reject(new Error(`MCP 进程退出 (code: ${code})`));
			}
			this.pending.clear();
		});
	}

	async send(message: JSONRPCRequest): Promise<JSONRPCResponse> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			const request = { ...message, id };
			this.pending.set(id, { resolve, reject });
			this.proc?.stdin?.write(`${JSON.stringify(request)}\n`);
		});
	}

	async close(): Promise<void> {
		for (const [, pending] of this.pending) {
			pending.reject(new Error("MCP 连接已关闭"));
		}
		this.pending.clear();
		this.proc?.kill();
		this.proc = null;
	}
}

// ===== HTTP 传输 =====

export class HttpTransport implements MCPTransport {
	private baseUrl: string;
	private headers: Record<string, string>;

	constructor(url: string, headers?: Record<string, string>) {
		this.baseUrl = url.replace(/\/$/, "");
		this.headers = { "Content-Type": "application/json", ...headers };
	}

	async connect(): Promise<void> {
		// HTTP 传输无需持久连接
	}

	async send(message: JSONRPCRequest): Promise<JSONRPCResponse> {
		const res = await fetch(`${this.baseUrl}/message`, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(message),
		});

		if (!res.ok) {
			// Try SSE endpoint
			const sseRes = await fetch(`${this.baseUrl}/sse`, {
				method: "POST",
				headers: this.headers,
				body: JSON.stringify(message),
			});
			if (!sseRes.ok) throw new Error(`MCP HTTP 错误: ${res.status}`);
			return (await sseRes.json()) as JSONRPCResponse;
		}

		return (await res.json()) as JSONRPCResponse;
	}

	async close(): Promise<void> {
		// HTTP 连接无需关闭
	}
}

// ===== MCP 客户端 =====

export class MCPClient {
	private transport: MCPTransport;
	private initialized = false;
	private nextId = 1;
	private toolsCache: MCPToolDefinition[] = [];
	private serverInfo: { name: string; version: string } = {
		name: "unknown",
		version: "0.0.0",
	};

	constructor(transport: MCPTransport) {
		this.transport = transport;
	}

	/** 连接并初始化 */
	async connect(): Promise<void> {
		await this.transport.connect();

		const response = await this.sendRequest("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			clientInfo: { name: "xuancode", version: "0.1.0" },
		});

		if (response.error)
			throw new Error(`MCP 初始化失败: ${response.error.message}`);
		if (response.result?.serverInfo) {
			this.serverInfo = response.result.serverInfo;
		}

		this.initialized = true;
	}

	/** 列出 MCP 服务器提供的工具 */
	async listTools(): Promise<MCPToolDefinition[]> {
		if (!this.initialized)
			throw new Error("MCP 客户端未初始化，请先调用 connect()");

		const response = await this.sendRequest("tools/list");
		if (response.error)
			throw new Error(`获取工具列表失败: ${response.error.message}`);

		this.toolsCache = response.result?.tools || [];
		return this.toolsCache;
	}

	/** 调用 MCP 工具 */
	async callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<MCPCallResult> {
		if (!this.initialized) throw new Error("MCP 客户端未初始化");

		const response = await this.sendRequest("tools/call", {
			name,
			arguments: args,
		});
		if (response.error)
			throw new Error(`MCP 工具调用失败: ${response.error.message}`);

		return response.result || { content: [{ type: "text", text: "无返回" }] };
	}

	/** 获取缓存的工具列表 */
	getCachedTools(): MCPToolDefinition[] {
		return this.toolsCache;
	}

	/** 获取服务器信息 */
	getServerInfo(): { name: string; version: string } {
		return this.serverInfo;
	}

	/** 断开连接 */
	async close(): Promise<void> {
		if (this.initialized) {
			await this.sendRequest("shutdown").catch(() => {});
			this.initialized = false;
		}
		await this.transport.close();
	}

	private async sendRequest(
		method: string,
		params?: Record<string, unknown>,
	): Promise<JSONRPCResponse> {
		return this.transport.send({
			jsonrpc: "2.0",
			id: this.nextId++,
			method,
			params,
		});
	}
}
