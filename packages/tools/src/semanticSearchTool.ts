import type { SearchResult } from "@xuancode/code-intelligence";
import type { ToolResult } from "@xuancode/types";

export type SearchProvider = (
	query: string,
	contextPath?: string,
) => Promise<SearchResult[]>;

let currentProvider: SearchProvider | null = null;

export function setSearchProvider(provider: SearchProvider): void {
	currentProvider = provider;
}

export function clearSearchProvider(): void {
	currentProvider = null;
}

export async function semanticSearch(
	query: string,
	contextPath?: string,
): Promise<ToolResult> {
	if (!currentProvider) {
		return {
			success: true,
			data: "语义搜索索引尚未就绪，请使用 grep 工具进行文本搜索。",
			duration: 0,
		};
	}

	const startTime = performance.now();

	try {
		const results = await currentProvider(query, contextPath);

		if (results.length === 0) {
			return {
				success: true,
				data: "未找到匹配的代码。可以尝试使用 grep 工具进行更精确的文本搜索。",
				duration: Math.round(performance.now() - startTime),
			};
		}

		const lines: string[] = [];
		lines.push(`找到 ${results.length} 个相关代码块：`);
		lines.push("");

		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const scorePct = Math.round(r.score * 100);
			const typeIcon =
				r.chunk.type === "function"
					? "ƒ"
					: r.chunk.type === "class"
						? "☰"
						: r.chunk.type === "interface"
							? "◎"
							: "¶";
			lines.push(`${i + 1}. [${scorePct}%] ${typeIcon} ${r.chunk.name}`);
			lines.push(`   路径: ${r.chunk.filePath}:${r.chunk.startLine}`);
			lines.push(`   匹配: ${r.matchedTokens.slice(0, 5).join(", ")}`);

			const snippetLines = r.chunk.content.split("\n").slice(0, 8);
			for (const sl of snippetLines) {
				lines.push(`   ${sl}`);
			}
			if (r.chunk.content.split("\n").length > 8) {
				lines.push(
					`   ... (${r.chunk.content.split("\n").length - 8} more lines)`,
				);
			}
			lines.push("");
		}

		return {
			success: true,
			data: lines.join("\n"),
			duration: Math.round(performance.now() - startTime),
		};
	} catch (err: any) {
		return {
			success: false,
			data: "",
			error: `语义搜索失败: ${err.message}`,
			duration: Math.round(performance.now() - startTime),
		};
	}
}

export const SEMANTIC_SEARCH_DEF = {
	type: "search",
	name: "search",
	description:
		'语义搜索代码库。根据概念关键词找到相关函数、类、接口和文件。支持自然语言查询（如"支付处理逻辑"或"用户认证流程"），索引会自动匹配相关代码。如果搜索无结果或索引未就绪请使用 grep 工具。',
	parameters: [
		{
			name: "query",
			type: "string" as const,
			description: "搜索查询，支持自然语言和关键词",
			required: true,
		},
		{
			name: "path",
			type: "string" as const,
			description: "上下文文件路径（用于结果排序，可选）",
			required: false,
		},
	],
	examples: [
		{ description: "搜索认证相关代码", params: { query: "用户认证登录" } },
		{ description: "搜索特定函数", params: { query: "handlePayment" } },
	],
	alwaysLoad: false,
	category: "wood" as const,
};
