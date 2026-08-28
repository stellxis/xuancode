import { parentPort } from "node:worker_threads";
import {
	type CommandMessage,
	type HeartbeatMessage,
	type RequestMessage,
	type WorkerMessage,
	createEvent,
	createResponse,
} from "./channel.js";

export abstract class UnitBase {
	protected abstract readonly unitName: string;

	private commandHandlers = new Map<
		string,
		(payload: unknown, correlationId: string) => Promise<void>
	>();
	private requestHandlers = new Map<
		string,
		(params: unknown, correlationId: string) => Promise<unknown>
	>();
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	protected startedAt = Date.now();

	constructor() {
		if (!parentPort) {
			throw new Error(
				`${this.constructor.name}: must be run as a worker thread`,
			);
		}

		parentPort.on("message", (msg: WorkerMessage) => {
			this.handleMessage(msg).catch((err) => {
				console.error(`[${this.unitName}] Unhandled message error:`, err);
			});
		});

		this.onCommand("ping", async () => {
			this.sendEvent("pong", { uptime: Date.now() - this.startedAt });
		});
	}

	// ---- Registration API ----

	protected onCommand(
		command: string,
		handler: (payload: unknown, correlationId: string) => Promise<void>,
	): void {
		this.commandHandlers.set(command, handler);
	}

	protected onRequest(
		method: string,
		handler: (params: unknown, correlationId: string) => Promise<unknown>,
	): void {
		this.requestHandlers.set(method, handler);
	}

	// ---- Send helpers ----

	protected sendEvent(event: string, payload?: unknown): void {
		parentPort?.postMessage(createEvent(event, payload));
	}

	protected sendResponse(
		correlationId: string,
		success: boolean,
		data?: unknown,
		error?: string,
	): void {
		parentPort?.postMessage(
			createResponse(correlationId, success, data, error),
		);
	}

	// ---- Heartbeat ----

	protected startHeartbeat(intervalMs = 5000): void {
		if (this.heartbeatTimer) return;
		this.heartbeatTimer = setInterval(() => {
			parentPort?.postMessage({
				type: "heartbeat",
				timestamp: Date.now(),
			} satisfies HeartbeatMessage);
		}, intervalMs);
		this.heartbeatTimer.unref();
	}

	protected stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	// ---- Message dispatch ----

	private async handleMessage(msg: WorkerMessage): Promise<void> {
		switch (msg.type) {
			case "command": {
				const handler = this.commandHandlers.get(msg.command);
				if (handler) {
					await handler(msg.payload, msg.correlationId);
				} else {
					console.warn(`[${this.unitName}] Unknown command: ${msg.command}`);
					this.sendResponse(
						msg.correlationId,
						false,
						undefined,
						`Unknown command: ${msg.command}`,
					);
				}
				break;
			}
			case "request": {
				const handler = this.requestHandlers.get(msg.method);
				if (handler) {
					try {
						const result = await handler(msg.params, msg.correlationId);
						this.sendResponse(msg.correlationId, true, result);
					} catch (err: any) {
						this.sendResponse(msg.correlationId, false, undefined, err.message);
					}
				} else {
					this.sendResponse(
						msg.correlationId,
						false,
						undefined,
						`Unknown method: ${msg.method}`,
					);
				}
				break;
			}
			case "heartbeat":
			case "event":
			case "response":
				// Not expected in worker → silent ignore
				break;
		}
	}
}
