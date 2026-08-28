/**
 * 玄码 CachedAdapter — 带缓存的模型适配器包装器
 *
 * 使用 ResponseCache 包装任意 ModelAdapter：
 * - chat() 先查缓存，命中直接返回，未命中调用 inner 再缓存
 * - chatStream() 不做缓存（流式不适合缓存）
 * - 支持缓存键基于消息内容 + system prompt
 */

import type { Message, ModelStreamEvent } from "@xuancode/types";
import { type CacheConfig, ResponseCache, buildCacheKey } from "./cache";
import type { ApiToolDefinition, ModelAdapter } from "./index";

export class CachedAdapter implements ModelAdapter {
	readonly provider: string;
	readonly modelName: string;
	private inner: ModelAdapter;
	private cache: ResponseCache;

	constructor(inner: ModelAdapter, cacheConfig?: Partial<CacheConfig>) {
		this.inner = inner;
		this.provider = inner.provider;
		this.modelName = inner.modelName;
		this.cache = new ResponseCache(cacheConfig);
	}

	async chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string> {
		const key = buildCacheKey(messages, systemPrompt);

		// 查缓存
		const cached = this.cache.get(key);
		if (cached !== null) {
			return cached;
		}

		// 调用 inner（tools 不参与缓存键，仅首次无缓存时生效）
		const response = await this.inner.chat(messages, systemPrompt, tools);

		// 写缓存
		this.cache.set(key, response, {
			provider: this.provider,
			model: this.modelName,
		});

		return response;
	}

	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<ModelStreamEvent, void, unknown> {
		// 流式不做缓存（逐 token 产出无法高效缓存）
		// 但可以用缓存跳过首次非流式调用
		for await (const token of this.inner.chatStream(
			messages,
			systemPrompt,
			tools,
		)) {
			yield token;
		}
	}

	/** 暴露底层缓存实例（用于统计/管理） */
	getCache(): ResponseCache {
		return this.cache;
	}
}
