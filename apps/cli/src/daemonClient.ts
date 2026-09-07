/**
 * Daemon HTTP + SSE 客户端
 * 纯 TypeScript，零外部依赖（使用 Node.js 内置 fetch）
 */

import {
	API_VERSION,
	API_VERSION_HEADER,
	MIN_SUPPORTED_API_VERSION,
	type TaskResult,
	type VersionInfo,
	type WorkflowEvent,
} from "@xuancode/daemon-protocol";

// WorkflowEvent / TaskResult 由 @xuancode/daemon-protocol 统一提供（线协议单点）
export type { WorkflowEvent, TaskResult };

// ===== Types =====

export interface StreamCallbacks {
	onConnected?: () => void;
	onTurn?: (turn: number) => void;
	onToken?: (token: string, fullText: string) => void;
	onToolCall?: (
		toolType: string,
		params: Record<string, unknown>,
		result: { success: boolean; error?: string },
	) => void;
	onError?: (message: string, site: string) => void;
	onComplete?: (result: TaskResult) => void;
	onErrorFatal?: (error: string) => void;
	onWorkflow?: (event: WorkflowEvent) => void;
	/** 实时进度摘要（「已读 N 文件 · 已改 M 文件 …」） */
	onProgress?: (info: {
		turn: number;
		summary: string;
		toolCallCount: number;
	}) => void;
	/** 任务已创建（返回 taskId，供后续 respondInput 使用） */
	onTaskCreated?: (taskId: string) => void;
	/** 模型调用 ask_user 工具，等待用户选择分支 */
	onAskUser?: (payload: { question: string; options?: string[] }) => void;
	/** 用户已通过 /tasks/:id/input 提交回答 */
	onInputResumed?: (payload: { answer: string }) => void;
}

// ===== DaemonClient =====

export class DaemonClient {
	private baseUrl: string;

	constructor(opts: { baseUrl: string }) {
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
	}

	/** 统一注入协议版本 header（缺失时旧 daemon 按 v1 放行） */
	private headers(extra?: Record<string, string>): Record<string, string> {
		return { [API_VERSION_HEADER]: String(API_VERSION), ...(extra || {}) };
	}

	/** 统一错误解析：识别 409 协议版本不兼容，给出升级提示 */
	private async parseError(res: Response, fallback: string): Promise<never> {
		const err: any = await res.json().catch(() => ({}));
		if (res.status === 409 && err?.code === "api_version_mismatch") {
			const serverApi = err.serverApiVersion ?? "?";
			throw new Error(
				`协议版本不兼容：daemon 为 API v${serverApi}，当前 CLI 为 v${API_VERSION}。请升级 CLI（npm install -g @xuancode/cli 或重新安装）。`,
			);
		}
		throw new Error(String(err.error || fallback));
	}

	/** GET /health */
	async checkHealth(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/health`, {
				headers: this.headers(),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	/** GET /version — 协议版本探测 */
	async getVersion(): Promise<VersionInfo> {
		const res = await fetch(`${this.baseUrl}/version`, {
			headers: this.headers(),
		});
		if (!res.ok) throw new Error(`获取版本信息失败: ${res.statusText}`);
		return res.json() as Promise<VersionInfo>;
	}

	/**
	 * 版本兼容性检查
	 * - daemon 无 /version（旧版）→ 视为 v1，兼容降级，不阻塞
	 * - daemon apiVersion > 本 CLI 支持版本 → 客户端过旧，需升级 CLI
	 * - daemon apiVersion < 最低支持版本 → daemon 过旧，需升级/重启 daemon
	 */
	async ensureCompatible(): Promise<{
		ok: boolean;
		needsUpgrade: "client" | "daemon" | null;
		daemonVersion?: string;
		serverApiVersion?: number;
	}> {
		try {
			const info = await this.getVersion();
			if (info.apiVersion > API_VERSION) {
				return {
					ok: false,
					needsUpgrade: "client",
					daemonVersion: info.daemonVersion,
					serverApiVersion: info.apiVersion,
				};
			}
			if (info.apiVersion < MIN_SUPPORTED_API_VERSION) {
				return {
					ok: false,
					needsUpgrade: "daemon",
					daemonVersion: info.daemonVersion,
					serverApiVersion: info.apiVersion,
				};
			}
			return {
				ok: true,
				needsUpgrade: null,
				daemonVersion: info.daemonVersion,
				serverApiVersion: info.apiVersion,
			};
		} catch {
			// 旧 daemon 无 /version → 默认兼容 v1
			return { ok: true, needsUpgrade: null };
		}
	}

	/** POST /daemon/configure */
	async configure(config: {
		provider: string;
		modelName: string;
		apiKey?: string;
	}): Promise<void> {
		const res = await fetch(`${this.baseUrl}/daemon/configure`, {
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify(config),
		});
		if (!res.ok) return this.parseError(res, "配置失败");
	}

	/** POST /tasks → { id } */
	async submitTask(
		input: string,
		config?: Record<string, unknown>,
		attachments?: Array<{
			name: string;
			data?: string;
			mimeType?: string;
			type: string;
			size?: number;
		}>,
	): Promise<{ id: string }> {
		const res = await fetch(`${this.baseUrl}/tasks`, {
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ input, config, attachments }),
		});
		if (!res.ok) return this.parseError(res, `提交任务失败: ${res.statusText}`);
		return res.json() as Promise<{ id: string }>;
	}

	/**
	 * GET /tasks/:id/stream — SSE 流解析
	 * 使用 Node.js 内置 fetch + ReadableStream，无外部依赖
	 * resolve 在 complete 事件时，reject 在 error_fatal 或重连耗尽时。
	 * 断线自动重连：携带 Last-Event-ID 头，daemon 会回放错过的缓冲事件（不丢不重）。
	 */
	async streamTask(
		taskId: string,
		callbacks: StreamCallbacks,
		signal?: AbortSignal,
	): Promise<TaskResult> {
		callbacks.onTaskCreated?.(taskId);
		const url = `${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/stream`;
		const MAX_RECONNECTS = 5;
		let lastEventId = 0;
		let attempts = 0;

		return new Promise<TaskResult>((outerResolve, outerReject) => {
			// 本次连接是否已落定（resolve/reject 后不再走断线重连）
			let settled = false;
			const settleResolve = (value: TaskResult): void => {
				settled = true;
				attempts = MAX_RECONNECTS + 1; // 已落定，禁止再重连
				outerResolve(value);
			};
			const settleReject = (err: Error): void => {
				settled = true;
				attempts = MAX_RECONNECTS + 1;
				outerReject(err);
			};

			const attempt = (): void => {
				if (signal?.aborted) {
					outerReject(new Error("已取消"));
					return;
				}
				const headers = this.headers();
				if (lastEventId > 0) {
					headers["Last-Event-ID"] = String(lastEventId);
				}

				// 断线处理：重连前确认任务还活着（已完成/失败的任务不再重连）
				const handleDisconnect = (err: unknown): void => {
					if (settled) return;
					attempts++;
					if (attempts > MAX_RECONNECTS || signal?.aborted) {
						settleReject(err instanceof Error ? err : new Error(String(err)));
						return;
					}
					fetch(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
						headers: this.headers(),
					})
						.then(
							(r) =>
								(r.ok ? r.json() : null) as Promise<{ status?: string } | null>,
						)
						.then((task) => {
							if (
								task &&
								["completed", "failed", "cancelled"].includes(task.status || "")
							) {
								settleReject(
									new Error(
										`任务已结束（${task.status}）但未收到 complete 事件`,
									),
								);
								return;
							}
							const delay = Math.min(8000, 500 * 2 ** (attempts - 1));
							setTimeout(attempt, delay);
						})
						.catch(() => {
							// daemon 不可达 → 按指数退避重试
							const delay = Math.min(8000, 500 * 2 ** (attempts - 1));
							setTimeout(attempt, delay);
						});
				};

				fetch(url, { signal, headers })
					.then((response) => {
						if (!response.ok) {
							throw new Error(`SSE 连接失败: ${response.statusText}`);
						}
						const body = response.body;
						if (!body) throw new Error("SSE 响应无 body");

						const reader = body.getReader();
						const decoder = new TextDecoder();
						let buffer = "";

						const pump = (): void => {
							reader
								.read()
								.then(({ done, value }) => {
									if (done) {
										// 流意外结束（未收到 complete）→ 视为断线，走重连
										handleDisconnect(new Error("SSE 流意外结束"));
										return;
									}

									buffer += decoder.decode(value, { stream: true });
									const blocks = buffer.split("\n\n");
									// 最后一个 block 可能不完整，留到下次
									buffer = blocks.pop() || "";

									for (const block of blocks) {
										if (!block.trim()) continue;
										// 记录事件序号，重连时据此回放缺口
										const idMatch = block.match(/^id: (\d+)$/m);
										if (idMatch) {
											lastEventId = Number.parseInt(idMatch[1], 10);
										}
										this.parseSSEBlock(
											block,
											callbacks,
											settleResolve,
											settleReject,
										);
									}

									pump();
								})
								.catch((err: unknown) => {
									handleDisconnect(
										err instanceof Error
											? err
											: new Error(`SSE 读取错误: ${err}`),
									);
								});
						};

						pump();
					})
					.catch((err: unknown) => {
						handleDisconnect(err);
					});
			};

			attempt();
		});
	}

	/**
	 * 便捷方法：submitTask + streamTask 串联
	 * 适用于一次一任务的场景（如非交互模式）
	 */
	async runTask(
		input: string,
		config: Record<string, unknown> | undefined,
		callbacks: StreamCallbacks,
		signal?: AbortSignal,
	): Promise<TaskResult> {
		const { id } = await this.submitTask(input, config);
		return this.streamTask(id, callbacks, signal);
	}

	/** POST /tasks/:id/input — 回复 ask_user 等待中的问题 */
	async respondInput(
		taskId: string,
		answer: string,
	): Promise<{ status: string; answer: string }> {
		const res = await fetch(
			`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/input`,
			{
				method: "POST",
				headers: this.headers({ "Content-Type": "application/json" }),
				body: JSON.stringify({ answer }),
			},
		);
		if (!res.ok) return this.parseError(res, `提交回答失败: ${res.statusText}`);
		return res.json() as Promise<{ status: string; answer: string }>;
	}

	// ===== private =====

	private parseSSEBlock(
		block: string,
		callbacks: StreamCallbacks,
		resolve: (value: TaskResult) => void,
		reject: (reason: Error) => void,
	): void {
		const lines = block.split("\n");
		let eventType = "message";
		let dataStr = "";

		for (const line of lines) {
			if (line.startsWith("event: ")) {
				eventType = line.slice(7).trim();
			} else if (line.startsWith("data: ")) {
				dataStr += line.slice(6);
			}
		}

		if (!dataStr) return;

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(dataStr);
		} catch {
			// 单条事件 JSON 解析失败，跳过
			return;
		}

		switch (eventType) {
			case "connected":
				callbacks.onConnected?.();
				break;

			case "turn":
				callbacks.onTurn?.((data as { turn: number }).turn);
				break;

			case "token": {
				const t = data as { token: string; fullText: string };
				callbacks.onToken?.(t.token, t.fullText);
				break;
			}

			case "tool_call": {
				const tc = data as {
					toolType: string;
					params: Record<string, unknown>;
					result: { success: boolean; error?: string };
				};
				callbacks.onToolCall?.(tc.toolType, tc.params, tc.result);
				break;
			}

			case "error":
				callbacks.onError?.(
					(data as { message: string }).message,
					(data as { site: string }).site || "",
				);
				break;

			case "complete": {
				const c = data as {
					finalAnswer: string;
					turnCount: number;
					toolCallCount: number;
					stopReason: string;
					duration: number;
				};
				const result: TaskResult = {
					finalAnswer: c.finalAnswer || "",
					turnCount: c.turnCount ?? 0,
					toolCallCount: c.toolCallCount ?? 0,
					stopReason: c.stopReason || "unknown",
					duration: c.duration ?? 0,
				};
				callbacks.onComplete?.(result);
				resolve(result);
				break;
			}

			case "error_fatal": {
				const errMsg = (data as { error: string }).error || "未知错误";
				callbacks.onErrorFatal?.(errMsg);
				reject(new Error(errMsg));
				break;
			}

			case "workflow": {
				callbacks.onWorkflow?.(data as any);
				break;
			}

			case "progress": {
				const p = data as {
					turn: number;
					summary: string;
					toolCallCount: number;
				};
				callbacks.onProgress?.(p);
				break;
			}

			case "ask_user": {
				const a = data as { question: string; options?: string[] };
				callbacks.onAskUser?.({
					question: a.question,
					options: a.options || [],
				});
				break;
			}

			case "input_received": {
				const i = data as { answer: string };
				callbacks.onInputResumed?.({ answer: i.answer });
				break;
			}
		}
	}
}
