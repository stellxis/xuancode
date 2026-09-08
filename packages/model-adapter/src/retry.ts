/**
 * 玄码 Model Adapter 重试中间件
 *
 * 包装任意 ModelAdapter，自动重试失败请求（指数退避）。
 * 仅重试可恢复错误（网络超时、5xx），不重试 4xx 错误。
 */

import type { Message, ModelStreamEvent } from "@xuancode/types";
import type { ApiToolDefinition, ModelAdapter } from "./index";

export interface RetryConfig {
	/** 最大重试次数，默认 3 */
	maxRetries: number;
	/** 初始退避延迟（毫秒），默认 1000 */
	baseDelay: number;
	/** 最大退避延迟（毫秒），默认 10000 */
	maxDelay: number;
}

const DEFAULT_CONFIG: RetryConfig = {
	maxRetries: 3,
	baseDelay: 1000,
	maxDelay: 10_000,
};

/** 判断是否为可重试的错误 */
function isRetryable(err: unknown): boolean {
	const msg = String(err);

	// 网络错误（fetch 自身异常）
	if (
		msg.includes("fetch") ||
		msg.includes("network") ||
		msg.includes("ECONNREFUSED") ||
		msg.includes("ENOTFOUND") ||
		msg.includes("ETIMEDOUT")
	) {
		return true;
	}

	// 5xx 服务端错误
	if (/5\d{2}/.test(msg)) return true;

	// 速率限制 (429)
	if (msg.includes("429") || msg.includes("rate limit")) return true;

	return false;
}

/** 计算退避延迟（带 jitter） */
function backoffDelay(
	attempt: number,
	baseDelay: number,
	maxDelay: number,
): number {
	const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
	// 加入 ±25% 随机 jitter
	const jitter = delay * (0.75 + Math.random() * 0.5);
	return Math.round(jitter);
}

export class RetryAdapter implements ModelAdapter {
	readonly provider: string;
	readonly modelName: string;
	private inner: ModelAdapter;
	private config: RetryConfig;

	constructor(inner: ModelAdapter, config?: Partial<RetryConfig>) {
		this.inner = inner;
		this.provider = inner.provider;
		this.modelName = inner.modelName;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	async chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
			try {
				return await this.inner.chat(messages, systemPrompt, tools);
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));

				if (attempt < this.config.maxRetries && isRetryable(err)) {
					const delay = backoffDelay(
						attempt,
						this.config.baseDelay,
						this.config.maxDelay,
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
				} else {
					throw lastError;
				}
			}
		}

		throw lastError || new Error("重试失败");
	}

	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<ModelStreamEvent, void, unknown> {
		let attempt = 0;
		while (true) {
			let emitted = false;
			try {
				// 富结构透传：文本增量与结构化工具调用事件原样转发
				for await (const token of this.inner.chatStream(
					messages,
					systemPrompt,
					tools,
				)) {
					emitted = true;
					yield token;
				}
				return; // 流式成功完成
			} catch (err) {
				const lastError = err instanceof Error ? err : new Error(String(err));
				// 仅在尚未产出任何 token（连接/请求级失败：429/5xx/超时）时退避重试；
				// 流中途重启会造成输出重复与重试标记污染模型响应，直接抛给上层恢复
				if (emitted || attempt >= this.config.maxRetries || !isRetryable(err)) {
					throw lastError;
				}
				const delay = backoffDelay(
					attempt,
					this.config.baseDelay,
					this.config.maxDelay,
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
				attempt++;
			}
		}
	}
}
