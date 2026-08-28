import type { ModelAdapter } from "@xuancode/model-adapter";
import type {
	InlineCompletion,
	InlineCompletionRequest,
} from "@xuancode/types";
import type { Message } from "@xuancode/types";

/**
 * 内联代码补全处理器
 *
 * 使用 FIM (Fill-in-the-Middle) 模式生成补全：
 * - DeepSeek 原生支持 <fim_prefix>/<fim_suffix>/<fim_middle> 标记
 * - 其他模型使用对话模板降级
 */

const FIM_PREFIX = "<｜fim▁begin｜>";
const FIM_SUFFIX = "<｜fim▁end｜>";
const FIM_MIDDLE = "<｜fim▁middle｜>";

export async function handleInlineCompletion(
	request: InlineCompletionRequest,
	model: ModelAdapter,
): Promise<InlineCompletion[]> {
	const { contextBefore, contextAfter, language } = request;

	// 跳过空上下文
	if (!contextBefore.trim() && !contextAfter.trim()) return [];

	try {
		const prompt = buildFimPrompt(contextBefore, contextAfter, language);
		const messages: Message[] = [{ role: "user", content: prompt }];

		let text: string;
		if (model.provider === "deepseek") {
			// DeepSeek 原生 FIM —— 用 chat 接口包裹
			text = await model.chat(
				messages,
				"你是一个代码补全引擎。只输出补全的代码，不要解释。",
			);
		} else {
			text = await model.chat(messages);
		}

		if (!text || text.length < 2) return [];

		// 清理输出：去掉可能的标记和多余空白
		text = cleanCompletion(text);

		return [{ text }];
	} catch {
		// 静默降级 —— 无补全总比报错好
		return [];
	}
}

function buildFimPrompt(
	prefix: string,
	suffix: string,
	language: string,
): string {
	// DeepSeek 原生 FIM 格式
	if (prefix.includes(FIM_PREFIX) || suffix.includes(FIM_SUFFIX)) {
		// 如果内容里已经包含标记，直接原样发送
		return `${prefix}${suffix}`;
	}

	// 将最后一段代码上下文包装为 FIM
	return `${FIM_PREFIX}${prefix}${FIM_SUFFIX}${suffix}${FIM_MIDDLE}`;
}

function cleanCompletion(text: string): string {
	// 移除 FIM 标记
	let cleaned = text
		.replace(/<\|fim_begin\|>/g, "")
		.replace(/<\|fim_end\|>/g, "")
		.replace(/<\|fim_middle\|>/g, "")
		.replace(/<｜fim▁begin｜>/g, "")
		.replace(/<｜fim▁end｜>/g, "")
		.replace(/<｜fim▁middle｜>/g, "");

	// 只保留第一段有意义的代码
	const lines = cleaned.split("\n");
	const result: string[] = [];
	let inCode = false;
	for (const line of lines) {
		if (line.startsWith("```")) {
			if (inCode) break; // 遇到闭合 ``` 停止
			inCode = true;
			continue;
		}
		if (inCode) {
			result.push(line);
		}
	}

	// 如果没找到代码块，取第一段非空内容
	if (result.length === 0) {
		// 去掉开头空白行
		cleaned = cleaned.trimStart();
		// 只取第一段（遇到两个连续换行停止）
		const firstBlock = cleaned.split(/\n\n+/)[0];
		return firstBlock.trim();
	}

	return result.join("\n").trim();
}
