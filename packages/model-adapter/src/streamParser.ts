/**
 * 玄码 SSE 流式解析器
 *
 * 提供 OpenAI 兼容的 SSE (Server-Sent Events) 流式解析，
 * 支持超时、心跳、usage 提取、finish_reason 捕获。
 */

export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export interface StreamChunk {
	/** 增量文本内容 */
	content?: string;
	/** 停止原因（仅最后一个 chunk 有值） */
	finishReason?: string | null;
	/** token 用量（仅最后一个 chunk 有值） */
	usage?: TokenUsage;
}

export interface StreamResult {
	/** 完整拼接的文本 */
	fullContent: string;
	/** 停止原因 */
	finishReason: string | null;
	/** token 用量 */
	usage: TokenUsage | null;
}

export interface StreamParserOptions {
	/** 首块超时（毫秒），默认 30000 */
	timeout?: number;
}

/**
 * 解析 OpenAI 兼容的 SSE 流式响应。
 *
 * 逐 chunk yield 内容增量，并在流结束时能通过 Generator 的 return 值
 * 获取完整文本、finish_reason 和 usage。
 *
 * 用法:
 * ```ts
 * const gen = parseSSEStream(response);
 * for await (const chunk of gen) {
 *   if (chunk.content) process(chunk.content);
 * }
 * const result = await gen.return(undefined);
 * console.log(result.value?.fullContent);
 * ```
 */
export async function* parseSSEStream(
	response: Response,
	options?: StreamParserOptions,
): AsyncGenerator<StreamChunk, StreamResult, unknown> {
	const timeout = options?.timeout ?? 30_000;
	const reader = response.body?.getReader();
	if (!reader) throw new Error("SSE 流: 响应体不可读");

	const decoder = new TextDecoder();
	let buffer = "";
	let fullContent = "";
	let finishReason: string | null = null;
	let usage: TokenUsage | null = null;
	let firstChunkReceived = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	/** 启动首块超时（只对第一个 chunk 生效） */
	const cancelTimeout = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};

	interface ToolCallAcc {
		id?: string;
		type?: string;
		name: string;
		arguments: string;
	}

	const toolCallAccums: Record<number, ToolCallAcc> = {};
	let toolCallFinished = false;

	try {
		while (true) {
			// 首块有超时保护，后续块直接等待
			if (!firstChunkReceived) {
				const timeoutPromise = new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`SSE 流超时: ${timeout}ms 内未收到数据`)),
						timeout,
					);
				});
				const readPromise = reader.read().then((r) => {
					cancelTimeout();
					return r;
				});
				const { done, value } = await Promise.race([
					readPromise,
					timeoutPromise,
				]);
				if (done) break;
				firstChunkReceived = true;
				buffer += decoder.decode(value, { stream: true });
			} else {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
			}

			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				// SSE 注释行（心跳）
				if (trimmed.startsWith(":")) continue;

				// 流结束标记
				if (trimmed === "data: [DONE]") {
					return { fullContent, finishReason, usage };
				}

				// 只处理 data: 行
				if (!trimmed.startsWith("data: ")) continue;

				const rawData = trimmed.slice(6);

				// 空 payload（data: 后无内容）
				if (!rawData) continue;

				try {
					const json = JSON.parse(rawData);
					const chunk: StreamChunk = {};

					// 提取增量内容
					const delta = json.choices?.[0]?.delta?.content;
					if (typeof delta === "string") {
						chunk.content = delta;
						fullContent += delta;
					}

					// 提取工具调用流式增量 (DeepSeek streaming tool_calls)
					const toolCallDeltas = json.choices?.[0]?.delta?.tool_calls;
					if (toolCallDeltas) {
						for (const tc of toolCallDeltas) {
							const idx = tc.index ?? 0;
							if (!toolCallAccums[idx]) {
								toolCallAccums[idx] = { name: "", arguments: "" };
							}
							if (tc.id) toolCallAccums[idx].id = tc.id;
							if (tc.type) toolCallAccums[idx].type = tc.type;
							if (tc.function?.name)
								toolCallAccums[idx].name += tc.function.name;
							if (tc.function?.arguments)
								toolCallAccums[idx].arguments += tc.function.arguments;
						}
					}

					// 提取 finish_reason
					const fr = json.choices?.[0]?.finish_reason;
					if (fr != null) {
						chunk.finishReason = fr;
						finishReason = fr;
						// finish_reason === "tool_calls" → 输出累计的工具调用 JSON
						// M1(C3)：JSON 行携带原生 tool_call 的 id，taorLoop 据此识别原生路径并做原生结果回灌
						if (fr === "tool_calls" && Object.keys(toolCallAccums).length > 0) {
							const entries = Object.values(toolCallAccums);
							const toToolJson = (tc: ToolCallAcc): string => {
								const base: Record<string, unknown> = { type: tc.name };
								if (tc.id) base.id = tc.id;
								try {
									const args = JSON.parse(tc.arguments || "{}");
									return JSON.stringify({ ...args, ...base });
								} catch {
									return JSON.stringify(base);
								}
							};
							const toolJson =
								entries.length === 1
									? toToolJson(entries[0])
									: entries.map(toToolJson).join("\n");
							toolCallFinished = true;
							chunk.content = (chunk.content || "") + toolJson;
							fullContent += toolJson;
						}
					}

					// 提取 usage（仅在最后一个 chunk 中出现）
					if (json.usage) {
						usage = {
							promptTokens: json.usage.prompt_tokens ?? 0,
							completionTokens: json.usage.completion_tokens ?? 0,
							totalTokens: json.usage.total_tokens ?? 0,
						};
						chunk.usage = usage;
					}

					if (
						chunk.content !== undefined ||
						chunk.finishReason !== undefined ||
						chunk.usage !== undefined
					) {
						yield chunk;
					}
				} catch (e) {
					// 解析失败时附带原始数据以便调试
					throw new Error(
						`SSE 数据解析失败: ${(e as Error).message}, 原始数据: ${rawData.slice(0, 200)}`,
					);
				}
			}
		}
	} finally {
		cancelTimeout();
		try {
			reader.cancel();
		} catch {
			/* ignore */
		}
	}

	return { fullContent, finishReason, usage };
}
