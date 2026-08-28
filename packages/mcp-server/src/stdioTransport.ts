/**
 * StdioTransport — MCP 标准输入/输出传输层
 *
 * 用于 CLI 模式：子进程通过 stdin/stdout 以 JSON-RPC 行进行通信。
 * 每条消息一行 JSON，末尾换行分隔。
 */

import { createInterface } from "node:readline";
import type {
	JSONRPCNotification,
	JSONRPCRequest,
	MCPTransport,
} from "./types.js";

export class StdioTransport implements MCPTransport {
	onMessage: ((msg: JSONRPCRequest | JSONRPCNotification) => void) | null =
		null;
	private closed = false;

	constructor() {
		const rl = createInterface({ input: process.stdin });
		rl.on("line", (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const msg = JSON.parse(trimmed);
				if (msg && typeof msg === "object" && msg.method) {
					this.onMessage?.(msg);
				}
			} catch {
				// 忽略无法解析的行
			}
		});

		rl.on("close", () => {
			this.closed = true;
		});
	}

	sendResponse(id: number | string | null, result: unknown): void {
		if (this.closed) return;
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
	}

	sendError(
		id: number | string | null,
		code: number,
		message: string,
		data?: unknown,
	): void {
		if (this.closed) return;
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`,
		);
	}

	sendNotification(method: string, params?: Record<string, unknown>): void {
		if (this.closed) return;
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	close(): void {
		this.closed = true;
	}
}
