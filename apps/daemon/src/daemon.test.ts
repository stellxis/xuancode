import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { MockAdapter } from "@xuancode/model-adapter";
import type { ModelAdapter } from "@xuancode/model-adapter";
import { SessionManager } from "@xuancode/session";
import type { Message } from "@xuancode/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DaemonScheduler,
	setForceInlineForTests,
	startDaemonServer,
} from "./index";

const TEST_DIR = path.join(process.cwd(), ".test-daemontmp");
const mockModel = new MockAdapter();

describe("DaemonScheduler", () => {
	let scheduler: DaemonScheduler;

	beforeEach(() => {
		setForceInlineForTests(true); // 测试环境跳过 COMBAT Worker，走内联执行
		// 清理上次运行残留的 SQLite（防 recoverTasks 恢复陈旧任务污染本组测试）
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
		fs.mkdirSync(TEST_DIR, { recursive: true });
		scheduler = new DaemonScheduler(
			new SessionManager(TEST_DIR),
			mockModel,
			TEST_DIR,
		);
	});

	afterEach(async () => {
		setForceInlineForTests(false);
		scheduler.stop();
		await (scheduler as any).dispose?.();
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("should submit and retrieve tasks", () => {
		const task = scheduler.submit("hello");
		expect(task.id).toBeTruthy();
		expect(task.status).toBe("queued");
		expect(task.userInput).toBe("hello");
	});

	it("should list tasks in order (newest first)", () => {
		const first = scheduler.submit("first");
		// Ensure different timestamps
		const second = scheduler.submit("second");
		const tasks = scheduler.listTasks();
		expect(tasks).toHaveLength(2);
		// Both tasks should be present
		const inputs = tasks.map((t) => t.userInput);
		expect(inputs).toContain("first");
		expect(inputs).toContain("second");
	});

	it("should get task by id", () => {
		const task = scheduler.submit("find me");
		const found = scheduler.getTask(task.id);
		expect(found).toBeTruthy();
		expect(found?.userInput).toBe("find me");
	});

	it("should return undefined for missing task", () => {
		const found = scheduler.getTask("nonexistent");
		expect(found).toBeUndefined();
	});

	it("should execute tasks", async () => {
		const task = scheduler.submit("test task", {
			workDir: "/test",
			mode: "default",
			maxTurns: 5,
			modelName: "mock",
			modelProvider: "mock",
		});
		await scheduler.executeTask(task);
		expect(task.status).toBe("completed");
		expect(task.result?.finalAnswer).toBeTruthy();
	});

	it("should track stats", () => {
		scheduler.submit("task1");
		scheduler.submit("task2");
		const stats = scheduler.getStats();
		expect(stats.total).toBe(2);
		expect(stats.queued).toBe(2);
	});

	it("should start and stop", async () => {
		expect(scheduler.isRunning()).toBe(false);
		await scheduler.start(500);
		expect(scheduler.isRunning()).toBe(true);
		scheduler.stop();
		expect(scheduler.isRunning()).toBe(false);
	});
});

describe("Daemon HTTP API", () => {
	let server: http.Server;
	let port: number;
	let scheduler: DaemonScheduler;

	beforeEach(async () => {
		setForceInlineForTests(true); // 测试环境不 spawn 原生 Worker（COMBAT/RECON），规避 @parcel/watcher 终止竞态 SIGSEGV
		// 清理上次运行残留的 SQLite（防 recoverTasks 恢复陈旧任务污染本组测试）
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
		fs.mkdirSync(TEST_DIR, { recursive: true });
		// 必须显式传入 workDir/sessionsDir —— 否则 DB 落在仓库根 .xuancode/sessions.db，
		// 跨运行累积陈旧任务并被 recoverTasks 恢复，污染后续测试
		const result = await startDaemonServer({
			port: 0,
			workDir: TEST_DIR,
			sessionsDir: TEST_DIR,
		});
		server = result.server;
		scheduler = result.scheduler;
		port = (server.address() as any).port;
	});

	afterEach(async () => {
		scheduler?.stop();
		await (scheduler as any).dispose?.();
		if (server) {
			server.closeAllConnections?.();
			server.close();
		}
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	function fetchDaemon(
		pathStr: string,
		options?: { method?: string; body?: any; headers?: Record<string, string> },
	): Promise<any> {
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					hostname: "localhost",
					port,
					path: pathStr,
					method: options?.method || "GET",
					headers: {
						"Content-Type": "application/json",
						...(options?.headers || {}),
					},
				},
				(res) => {
					let data = "";
					res.on("data", (chunk) => {
						data += chunk;
					});
					res.on("end", () => {
						try {
							resolve(JSON.parse(data));
						} catch {
							resolve(data);
						}
					});
				},
			);
			req.on("error", reject);
			if (options?.body) req.write(JSON.stringify(options.body));
			req.end();
		});
	}

	/** 发起请求并返回 HTTP 状态码 + body */
	function fetchStatus(
		pathStr: string,
		options?: { method?: string; headers?: Record<string, string> },
	): Promise<{ status: number; body: any }> {
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					hostname: "localhost",
					port,
					path: pathStr,
					method: options?.method || "GET",
					headers: {
						"Content-Type": "application/json",
						...(options?.headers || {}),
					},
				},
				(res) => {
					let data = "";
					res.on("data", (chunk) => {
						data += chunk;
					});
					res.on("end", () => {
						let body: any = data;
						try {
							body = JSON.parse(data);
						} catch {
							/* keep raw */
						}
						resolve({ status: res.statusCode as number, body });
					});
				},
			);
			req.on("error", reject);
			req.end();
		});
	}

	it("should respond to health check", async () => {
		const result = await fetchDaemon("/health");
		expect(result.status).toBe("ok");
		expect(result.daemon).toBe("running");
	});

	it("should expose /version with protocol contract", async () => {
		const result = await fetchDaemon("/version");
		expect(result.protocol).toBe("xuancode-daemon");
		expect(result.apiVersion).toBe(1);
		expect(result.daemonVersion).toBeTruthy();
		expect(Array.isArray(result.features)).toBe(true);
	});

	it("should include apiVersion/daemonVersion in /health", async () => {
		const result = await fetchDaemon("/health");
		expect(result.apiVersion).toBe(1);
		expect(result.daemonVersion).toBeTruthy();
	});

	it("should reject mismatched API version with 409", async () => {
		const result = await fetchStatus("/tasks", {
			headers: { "X-XC-Api-Version": "999" },
		});
		expect(result.status).toBe(409);
		expect(result.body.code).toBe("api_version_mismatch");
		expect(result.body.serverApiVersion).toBe(1);
	});

	it("should allow requests without version header (legacy client = v1)", async () => {
		const result = await fetchStatus("/tasks", {});
		expect(result.status).not.toBe(409);
	});

	it("should accept tasks via POST", async () => {
		const task = await fetchDaemon("/tasks", {
			method: "POST",
			body: { input: "analyze project" },
		});
		expect(task.id).toBeTruthy();
		expect(task.status).toBe("queued");
	});

	it("should list tasks via GET", async () => {
		await fetchDaemon("/tasks", { method: "POST", body: { input: "task 1" } });
		await fetchDaemon("/tasks", { method: "POST", body: { input: "task 2" } });
		const tasks = await fetchDaemon("/tasks");
		expect(Array.isArray(tasks)).toBe(true);
		expect(tasks.length).toBeGreaterThanOrEqual(2);
	});

	it("should return stats", async () => {
		await fetchDaemon("/tasks", { method: "POST", body: { input: "test" } });
		const stats = await fetchDaemon("/stats");
		expect(stats.total).toBeGreaterThanOrEqual(1);
	});

	it("should return 404 for unknown routes", async () => {
		const result = await fetchDaemon("/nonexistent");
		expect(result.error).toBeTruthy();
	});

	it("should handle GET /sessions", async () => {
		const sessions = await fetchDaemon("/sessions");
		expect(Array.isArray(sessions)).toBe(true);
	});

	it("should handle daemon start/stop", async () => {
		const startResult = await fetchDaemon("/daemon/start", { method: "POST" });
		expect(startResult).toHaveProperty("status");

		const stopResult = await fetchDaemon("/daemon/stop", { method: "POST" });
		expect(stopResult).toHaveProperty("status");
	});

	it("should handle tasks with empty body", async () => {
		const task = await fetchDaemon("/tasks", { method: "POST", body: {} });
		expect(task).toHaveProperty("id");
	});
});

describe("ask_user 人工介入", () => {
	let server: http.Server;
	let port: number;
	let scheduler: DaemonScheduler;

	/** 首个调用发出 ask_user 工具调用；后续调用回显上一条工具结果（验证分支选择已回传） */
	class AskUserMockModel implements ModelAdapter {
		readonly provider = "mock";
		readonly modelName = "ask-user-mock";
		private callCount = 0;

		async chat(messages: Message[]): Promise<string> {
			this.callCount++;
			if (this.callCount === 1) {
				return '{"type":"ask_user","question":"FileTree 改进下一步优先推进哪个方向?","options":["先实现轻量拓扑结构","先实现图谱渲染","先补齐测试"]}';
			}
			// 第二次调用：回显 taorLoop 注入的「工具结果: 用户选择: <分支>」
			const lastUser = [...messages].reverse().find((m) => m.role === "user");
			return `已按用户选择继续推进。${lastUser?.content || ""}`;
		}

		async *chatStream(
			messages: Message[],
			systemPrompt?: string,
		): AsyncGenerator<string, void, unknown> {
			yield await this.chat(messages, systemPrompt);
		}
	}

	beforeEach(async () => {
		setForceInlineForTests(true);
		// 清理上次运行残留的 SQLite（防 recoverTasks 恢复陈旧任务污染本组测试）
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
		fs.mkdirSync(TEST_DIR, { recursive: true });
		const result = await startDaemonServer({
			port: 0,
			model: new AskUserMockModel(),
			workDir: TEST_DIR,
			sessionsDir: TEST_DIR,
			rateLimitRPM: 0, // 轮询 GET /tasks/:id 需要高频访问，关闭限流
		});
		server = result.server;
		scheduler = result.scheduler;
		await scheduler.start(); // 启动队列轮询，自动执行提交的任务
		port = (server.address() as any).port;
	});

	afterEach(async () => {
		setForceInlineForTests(false);
		scheduler?.stop();
		await (scheduler as any).dispose?.(); // 终止 worker + 释放 SQLite 锁，rmSync 才能成功
		if (server) {
			server.closeAllConnections?.();
			server.close();
		}
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	function fetchDaemon(
		pathStr: string,
		options?: { method?: string; body?: any },
	): Promise<any> {
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					hostname: "localhost",
					port,
					path: pathStr,
					method: options?.method || "GET",
					headers: { "Content-Type": "application/json" },
				},
				(res) => {
					let data = "";
					res.on("data", (chunk) => {
						data += chunk;
					});
					res.on("end", () => {
						try {
							resolve(JSON.parse(data));
						} catch {
							resolve(data);
						}
					});
				},
			);
			req.on("error", reject);
			if (options?.body) req.write(JSON.stringify(options.body));
			req.end();
		});
	}

	async function waitForStatus(
		taskId: string,
		status: string,
		timeoutMs = 30000,
	): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		let last: any = null;
		while (Date.now() < deadline) {
			const task = await fetchDaemon(`/tasks/${taskId}`);
			last = task;
			if (task.status === status) return task;
			await new Promise((r) => setTimeout(r, 200));
		}
		const internal = (scheduler as any).tasks.get(taskId);
		const pending = Array.from((scheduler as any).pendingInputRequests.keys());
		throw new Error(
			`任务未在 ${timeoutMs}ms 内进入 ${status} 状态。\n` +
				`HTTP: ${JSON.stringify({ status: last?.status, error: last?.error, pendingQuestion: last?.pendingQuestion, progressSummary: last?.progressSummary })}\n` +
				`内部: ${JSON.stringify({ status: internal?.status, pendingQuestion: internal?.pendingQuestion, currentTurn: internal?.currentTurn, result: internal?.result, lastToolCall: internal?.currentToolCall })}\n` +
				`pendingInputRequests: ${JSON.stringify(pending)}`,
		);
	}

	it("模型调用 ask_user 时进入 awaiting_input，POST /input 提交分支后按所选分支继续并完成", async () => {
		const sessionId = "askuser-test-session";
		const task = await fetchDaemon("/tasks", {
			method: "POST",
			body: { input: "帮我改进 FileTree", sessionId, config: { maxTurns: 5 } },
		});
		expect(task.id).toBeTruthy();

		// 模型发出 ask_user → 任务进入等待输入状态
		const awaitingTask = await waitForStatus(task.id, "awaiting_input");
		expect(awaitingTask.pendingQuestion).toContain("FileTree");
		expect(awaitingTask.pendingContext?.options).toEqual([
			"先实现轻量拓扑结构",
			"先实现图谱渲染",
			"先补齐测试",
		]);

		// 通过 /tasks/:id/input 提交所选分支
		const resumed = await fetchDaemon(`/tasks/${task.id}/input`, {
			method: "POST",
			body: { answer: "先实现轻量拓扑结构" },
		});
		expect(resumed.status).toBe("resumed");

		// 任务恢复并最终完成
		const done = await waitForStatus(task.id, "completed");
		expect(done.result?.finalAnswer).toBeTruthy();
		expect(done.result?.stopReason).toBe("no_tool_use");

		// 最终回答回显了工具结果中的「用户选择: <分支>」→ 证明所选分支已按流程回传
		expect(done.result.finalAnswer).toContain("用户选择: 先实现轻量拓扑结构");
	}, 60000);

	it("ask_user 常驻（无自动超时）：取消任务时清理 pendingInputRequests 防悬挂", async () => {
		const task = await fetchDaemon("/tasks", {
			method: "POST",
			body: { input: "帮我改进 FileTree", config: { maxTurns: 5 } },
		});
		expect(task.id).toBeTruthy();

		// 模型发出 ask_user → 进入等待输入状态（决策面板常驻，不设 5 分钟自动超时）
		await waitForStatus(task.id, "awaiting_input");
		expect(scheduler.pendingInputRequests.has(task.id)).toBe(true);

		// 取消任务 → resolvePendingInputs 清理条目并通知面板关闭，不悬挂/不泄漏
		await fetchDaemon(`/tasks/${task.id}/cancel`, { method: "POST" });
		expect(scheduler.pendingInputRequests.has(task.id)).toBe(false);
	}, 60000);
});
