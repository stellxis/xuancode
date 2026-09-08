import http from "node:http";
import { API_VERSION_HEADER } from "@xuancode/daemon-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "./daemonClient";

const servers: http.Server[] = [];

function startMockDaemon(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		servers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as any;
			resolve(`http://127.0.0.1:${addr.port}`);
		});
	});
}

afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

describe("DaemonClient 协议版本协商", () => {
	it("getVersion 请求携带 X-XC-Api-Version header", async () => {
		let seenHeader: string | undefined;
		const baseUrl = await startMockDaemon((req, res) => {
			seenHeader = req.headers[API_VERSION_HEADER.toLowerCase()] as
				| string
				| undefined;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					protocol: "xuancode-daemon",
					apiVersion: 1,
					daemonVersion: "0.1.0",
					features: [],
				}),
			);
		});
		const client = new DaemonClient({ baseUrl });
		const info = await client.getVersion();
		expect(info.apiVersion).toBe(1);
		expect(seenHeader).toBe("1");
	});

	it("版本一致 → ok", async () => {
		const baseUrl = await startMockDaemon((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					protocol: "xuancode-daemon",
					apiVersion: 1,
					daemonVersion: "0.1.0",
					features: [],
				}),
			);
		});
		const client = new DaemonClient({ baseUrl });
		const compat = await client.ensureCompatible();
		expect(compat.ok).toBe(true);
		expect(compat.needsUpgrade).toBeNull();
		expect(compat.daemonVersion).toBe("0.1.0");
	});

	it("daemon 协议更新 → 客户端需升级", async () => {
		const baseUrl = await startMockDaemon((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					protocol: "xuancode-daemon",
					apiVersion: 2,
					daemonVersion: "0.2.0",
					features: [],
				}),
			);
		});
		const client = new DaemonClient({ baseUrl });
		const compat = await client.ensureCompatible();
		expect(compat.ok).toBe(false);
		expect(compat.needsUpgrade).toBe("client");
	});

	it("daemon 协议过旧 → daemon 需升级", async () => {
		const baseUrl = await startMockDaemon((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					protocol: "xuancode-daemon",
					apiVersion: 0,
					daemonVersion: "0.0.9",
					features: [],
				}),
			);
		});
		const client = new DaemonClient({ baseUrl });
		const compat = await client.ensureCompatible();
		expect(compat.ok).toBe(false);
		expect(compat.needsUpgrade).toBe("daemon");
	});

	it("旧 daemon 无 /version → 优雅降级为 v1，不阻塞", async () => {
		const baseUrl = await startMockDaemon((req, res) => {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "未找到路由" }));
		});
		const client = new DaemonClient({ baseUrl });
		const compat = await client.ensureCompatible();
		expect(compat.ok).toBe(true);
		expect(compat.needsUpgrade).toBeNull();
	});
});

describe("DaemonClient 任务列表与重连", () => {
	it("listTasks 请求携带 limit 参数并解析列表", async () => {
		let seenPath = "";
		const baseUrl = await startMockDaemon((req, res) => {
			seenPath = req.url || "";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify([
					{
						id: "task-abc123",
						status: "running",
						userInput: "修复登录页",
						currentTurn: 3,
					},
					{ id: "task-def456", status: "completed", userInput: "写单测" },
				]),
			);
		});
		const client = new DaemonClient({ baseUrl });
		const tasks = await client.listTasks(20);
		expect(seenPath).toBe("/tasks?limit=20");
		expect(tasks).toHaveLength(2);
		expect(tasks[0]).toMatchObject({ id: "task-abc123", status: "running" });
		expect(tasks[0].currentTurn).toBe(3);
	});

	it("重连运行中的任务：接收后续事件直到 complete", async () => {
		const baseUrl = await startMockDaemon((req, res) => {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
			});
			// 模拟重连后 daemon 只推送新事件
			res.write('event: turn\ndata: {"turn": 7}\n\n');
			res.write(
				'event: workflow\ndata: {"type": "step_completed", "stepId": "s1"}\n\n',
			);
			setTimeout(() => {
				res.write(
					`event: complete\ndata: ${JSON.stringify({
						finalAnswer: "任务完成",
						turnCount: 8,
						toolCallCount: 12,
						stopReason: "no_tool_use",
						duration: 42000,
						contextUsage: 34,
					})}\n\n`,
				);
				res.end();
			}, 30);
		});
		const client = new DaemonClient({ baseUrl });
		const events: string[] = [];
		let lastTurn = 0;
		let workflowStep = "";
		const result = await client.streamTask("task-running-1", {
			onTurn: (t) => {
				lastTurn = t;
			},
			onWorkflow: (ev: any) => {
				events.push(ev.type);
				workflowStep = ev.stepId;
			},
		});
		expect(lastTurn).toBe(7);
		expect(events).toEqual(["step_completed"]);
		expect(workflowStep).toBe("s1");
		expect(result).toMatchObject({
			finalAnswer: "任务完成",
			turnCount: 8,
			stopReason: "no_tool_use",
			contextUsage: 34,
		});
	});
});
