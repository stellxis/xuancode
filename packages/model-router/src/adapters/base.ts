import type { Message, ModelStreamEvent } from "@xuancode/types";
import type { ApiToolDefinition, ProviderAdapter } from "../types";

/**
 * Abstract base class for provider adapters.
 * Subclasses must implement chat() and chatStream().
 */
export abstract class BaseAdapter implements ProviderAdapter {
	abstract readonly provider: string;
	abstract readonly model: string;

	abstract chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string>;

	abstract chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<ModelStreamEvent, void, unknown>;

	/**
	 * Build content field for OpenAI-compatible APIs.
	 * Returns a plain string when no attachments (backward compatible),
	 * or an array of content blocks when image attachments are present.
	 */
	static buildOpenAIContent(msg: Message): string | Array<Record<string, any>> {
		const images = msg.attachments?.filter((a) => a.type === "image" && a.data);
		if (!images || images.length === 0) {
			return msg.content;
		}
		const blocks: Array<Record<string, any>> = [];
		if (msg.content.trim()) {
			blocks.push({ type: "text", text: msg.content });
		}
		for (const img of images) {
			blocks.push({
				type: "image_url",
				image_url: {
					url: `data:${img.mimeType || "image/png"};base64,${img.data}`,
				},
			});
		}
		return blocks;
	}

	/**
	 * Build content field for Anthropic Messages API.
	 * Anthropic uses content blocks natively.
	 */
	static buildAnthropicContent(
		msg: Message,
	): string | Array<Record<string, any>> {
		const images = msg.attachments?.filter((a) => a.type === "image" && a.data);
		if (!images || images.length === 0) {
			return msg.content;
		}
		const blocks: Array<Record<string, any>> = [];
		if (msg.content.trim()) {
			blocks.push({ type: "text", text: msg.content });
		}
		for (const img of images) {
			blocks.push({
				type: "image",
				source: {
					type: "base64",
					media_type: img.mimeType || "image/png",
					data: img.data,
				},
			});
		}
		return blocks;
	}

	/**
	 * 序列化单条消息为 Anthropic Messages API 格式。
	 * - role:"tool" → user 消息携带 tool_result content block（引用 tool_use_id）
	 * - assistant 携带 toolCalls → content blocks 追加结构化 tool_use（id/name/input）
	 * - 否则保持文本/图片 blocks（buildAnthropicContent）
	 */
	static buildAnthropicMessage(m: Message): Record<string, any> {
		if (m.role === "tool") {
			return {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: m.tool_call_id || "",
						content: m.content,
					},
				],
			};
		}
		const msg: Record<string, any> = {
			role: m.role,
			content: BaseAdapter.buildAnthropicContent(m),
		};
		if (m.toolCalls && m.toolCalls.length > 0) {
			const base = BaseAdapter.buildAnthropicContent(m);
			const blocks: Array<Record<string, any>> = [];
			const hasText =
				typeof base === "string" ? base.trim().length > 0 : base.length > 0;
			if (hasText) {
				if (typeof base === "string") {
					blocks.push({ type: "text", text: base });
				} else {
					blocks.push(...base);
				}
			}
			for (const tc of m.toolCalls) {
				let input: unknown = {};
				try {
					input = JSON.parse(tc.arguments);
				} catch {
					input = {};
				}
				blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
			}
			msg.content = blocks;
		}
		return msg;
	}

	/**
	 * 序列化单条消息为 Gemini generateContent 格式。
	 * - role:"tool" → user 消息携带 functionResponse part（name 由合成 id "name::index" 还原；response 解析为对象）
	 * - assistant 携带 toolCalls → parts 追加结构化 functionCall（name/args 由 JSON.parse(arguments)）
	 * - 否则保持文本/图片 parts（buildGeminiParts）
	 */
	static buildGeminiMessage(m: Message): Record<string, any> {
		if (m.role === "tool") {
			const id = m.tool_call_id || "";
			// M4：Gemini 协议无原生 id，合成 id 形如 "name::index" → 还原函数名以匹配 functionCall
			const name = id.includes("::") ? id.slice(0, id.indexOf("::")) : id;
			let response: unknown = m.content;
			try {
				response = JSON.parse(m.content);
			} catch {
				// 非 JSON 文本 → 原样作为响应
			}
			return {
				role: "user",
				parts: [{ functionResponse: { name, response } }],
			};
		}
		const msg: Record<string, any> = {
			role: m.role === "assistant" ? "model" : m.role,
			parts: BaseAdapter.buildGeminiParts(m),
		};
		if (m.toolCalls && m.toolCalls.length > 0) {
			for (const tc of m.toolCalls) {
				let args: Record<string, any> = {};
				try {
					args = JSON.parse(tc.arguments);
				} catch {
					args = {};
				}
				msg.parts.push({ functionCall: { name: tc.name, args } });
			}
		}
		return msg;
	}

	/**
	 * Build Gemini parts array, including inline_data for image attachments.
	 */
	static buildGeminiParts(msg: Message): Array<Record<string, any>> {
		const parts: Array<Record<string, any>> = [];
		if (msg.content.trim()) {
			parts.push({ text: msg.content });
		}
		if (msg.attachments) {
			for (const att of msg.attachments) {
				if (att.type === "image" && att.data) {
					parts.push({
						inlineData: {
							mimeType: att.mimeType || "image/png",
							data: att.data,
						},
					});
				}
			}
		}
		return parts;
	}

	/**
	 * 序列化单条消息为 OpenAI 兼容格式。
	 * 原生工具调用（m.toolCalls）存在时 content 置空并以 tool_calls 结构下发——
	 * 这是 DeepSeek 等严格厂商要求的形态（content 与 tool_calls 不同存），也更省 token。
	 */
	static buildOpenAIMessage(m: Message): Record<string, any> {
		const msg: Record<string, any> = {
			role: m.role,
			content: BaseAdapter.buildOpenAIContent(m),
		};
		if (m.name) msg.name = m.name;
		if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
		if (m.toolCalls && m.toolCalls.length > 0) {
			msg.content = "";
			msg.tool_calls = m.toolCalls.map((tc) => ({
				id: tc.id,
				type: "function",
				function: { name: tc.name, arguments: tc.arguments },
			}));
		}
		return msg;
	}

	/**
	 * 从非流式 chat 响应中提取 tool_calls 为 JSON 行文本（带原生 id）。
	 * 与 streamParser 的 finish_reason=tool_calls 注入保持同构：{...args, ...{type,id}}。
	 * 无 tool_calls 时返回 null，由调用方回落到纯文本 content。
	 */
	static extractToolCallsText(message: any): string | null {
		const tcs = message?.tool_calls;
		if (!tcs || !Array.isArray(tcs) || tcs.length === 0) return null;
		const lines: string[] = [];
		for (const tc of tcs) {
			const base: Record<string, any> = { type: tc?.function?.name };
			if (tc?.id) base.id = tc.id;
			try {
				const args = JSON.parse(tc?.function?.arguments || "{}");
				lines.push(JSON.stringify({ ...args, ...base }));
			} catch {
				lines.push(JSON.stringify(base));
			}
		}
		return lines.join("\n");
	}
}
