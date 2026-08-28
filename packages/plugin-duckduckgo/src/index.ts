/**
 * 玄码 DuckDuckGo 网页搜索插件
 * 五行分类: 水 (water) — 网络/数据/API
 *
 * 提供 web_search 工具，通过 DuckDuckGo 获取搜索引擎结果。
 * 零配置，免 API Key，即装即用。
 */

import { createPlugin } from "@xuancode/plugins";

export default createPlugin(
	{
		name: "duckduckgo",
		version: "0.1.0",
		description: "DuckDuckGo 网页搜索 — 零配置，免 API Key，即装即用",
		author: "玄码",
		element: "water",
		events: [],
	},
	async (ctx, api) => {
		if (!api.registerTool) throw new Error("当前插件宿主不支持 registerTool");
		api.registerTool("web_search", async (args: any) => {
			const query = args.query || args.q;
			if (!query) {
				return { success: false, error: "缺少必填参数: query" };
			}

			const num = Math.min(args.num || 5, 20);

			try {
				// DuckDuckGo HTML 端点 — 无需 API Key
				// 必须设置 User-Agent 否则被屏蔽
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 15000);
				const headers = {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
				};
				const body = new URLSearchParams({ q: query });
				const res = await fetch("https://html.duckduckgo.com/html/", {
					method: "POST",
					headers,
					body,
					signal: controller.signal,
				});
				clearTimeout(timeout);

				if (!res.ok) {
					return {
						success: false,
						error: `DuckDuckGo 请求失败: ${res.status}`,
					};
				}

				const html = await res.text();
				const results: Array<{ title: string; url: string; snippet: string }> =
					[];

				// 解析 DuckDuckGo HTML 结果
				const resultRegex =
					/<div[^>]*class="result__title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

				let match: RegExpExecArray | null;
				while (true) {
					match = resultRegex.exec(html);
					if (match === null || results.length >= num) break;
					results.push({
						url: match[1],
						title: match[2]
							.replace(/<[^>]*>/g, "")
							.replace(/\s+/g, " ")
							.trim(),
						snippet: match[3]
							.replace(/<[^>]*>/g, "")
							.replace(/\s+/g, " ")
							.trim(),
					});
				}

				return {
					success: true,
					data: {
						results,
						total: results.length,
						engine: "duckduckgo",
						query,
					},
				};
			} catch (err: any) {
				return { success: false, error: `DuckDuckGo 调用异常: ${err.message}` };
			}
		});

		ctx.log("DuckDuckGo 插件已初始化 (免 API Key，零配置)");
	},
);
