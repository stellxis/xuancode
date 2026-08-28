/**
 * web_search / web_fetch — 联网工具
 *
 * web_search: 通过搜索引擎查询信息
 * web_fetch:  获取 URL 内容并转为 Markdown
 *
 * 使用 SerpAPI (serpapi.com) 进行搜索，免费层每月 100 次查询。
 * API Key 通过 SERPAPI_API_KEY 环境变量配置。
 */

import type { ToolResult } from "@xuancode/types";

const SERPAPI_BASE = "https://serpapi.com/search";

/**
 * Web Search — 使用 SerpAPI 进行网络搜索
 */
export async function webSearch(query: string): Promise<ToolResult> {
	const startTime = performance.now();

	if (!query || query.trim().length === 0) {
		return {
			success: false,
			data: "",
			error: "搜索关键词不能为空",
			duration: performance.now() - startTime,
		};
	}

	const apiKey = process.env.SERPAPI_API_KEY || process.env.SEARCH_API_KEY;
	if (!apiKey) {
		// 降级：没有 API key，返回提示
		return {
			success: true,
			data: `[联网搜索功能未配置] 搜索词: "${query}"\n请设置 SERPAPI_API_KEY 环境变量以启用联网搜索。\n免费注册: https://serpapi.com/`,
			duration: performance.now() - startTime,
		};
	}

	try {
		const url = new URL(SERPAPI_BASE);
		url.searchParams.set("q", query);
		url.searchParams.set("api_key", apiKey);
		url.searchParams.set("num", "5");
		url.searchParams.set("engine", "google");

		const res = await fetch(url.toString(), {
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

		const data: any = await res.json();

		if (data.error) {
			return {
				success: false,
				data: "",
				error: `搜索 API 错误: ${data.error}`,
				duration: performance.now() - startTime,
			};
		}

		const results = data.organic_results || [];
		if (results.length === 0) {
			return {
				success: true,
				data: `搜索 "${query}" 无结果`,
				duration: performance.now() - startTime,
			};
		}

		const formatted = results
			.map(
				(r: any, i: number) =>
					`[${i + 1}] ${r.title}\n    ${r.snippet || ""}\n    ${r.link}`,
			)
			.join("\n\n");

		return {
			success: true,
			data: `搜索结果: "${query}"\n\n${formatted}`,
			duration: performance.now() - startTime,
		};
	} catch (err: any) {
		return {
			success: true,
			data: `[搜索失败: ${err.message}]`,
			duration: performance.now() - startTime,
		};
	}
}

/**
 * Web Fetch — 获取 URL 内容并转为纯文本
 */
export async function webFetch(urlStr: string): Promise<ToolResult> {
	const startTime = performance.now();

	if (!urlStr || urlStr.trim().length === 0) {
		return {
			success: false,
			data: "",
			error: "URL 不能为空",
			duration: performance.now() - startTime,
		};
	}

	try {
		// 验证 URL
		const parsed = new URL(urlStr);
		if (!["http:", "https:"].includes(parsed.protocol)) {
			return {
				success: false,
				data: "",
				error: "仅支持 http/https 协议",
				duration: performance.now() - startTime,
			};
		}

		const res = await fetch(urlStr, {
			signal: AbortSignal.timeout(15000),
			headers: { "User-Agent": "XuanCode/0.1 (AI Coding Assistant)" },
		});

		if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

		const contentType = res.headers.get("content-type") || "";
		const text = await res.text();

		// 简单转纯文本：去掉 HTML 标签
		const isHtml =
			contentType.includes("text/html") || contentType.includes("text/plain");
		if (!isHtml && !contentType.includes("json")) {
			// 非文本内容，只返回元信息
			return {
				success: true,
				data: `[${contentType}] ${text.length} bytes`,
				duration: performance.now() - startTime,
			};
		}

		const cleanText = isHtml
			? text
					.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
					.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
					.replace(/<[^>]+>/g, "")
					.replace(/\n{3,}/g, "\n\n")
					.trim()
			: text;

		const maxLen = 8000;
		const content =
			cleanText.length > maxLen
				? `${cleanText.slice(0, maxLen)}\n\n... (已截断, 原文 ${cleanText.length} 字符)`
				: cleanText;

		return {
			success: true,
			data: `内容: ${urlStr}\n\n${content}`,
			duration: performance.now() - startTime,
		};
	} catch (err: any) {
		return {
			success: true,
			data: `[获取失败: ${err.message}]`,
			duration: performance.now() - startTime,
		};
	}
}
