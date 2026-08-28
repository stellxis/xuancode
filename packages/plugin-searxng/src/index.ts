/**
 * 玄码 SearXNG 自建搜索引擎插件
 * 五行分类: 水 (water) — 网络/数据/API
 *
 * 提供 web_search 工具，通过自建 SearXNG 实例获取搜索结果。
 * 需要配置 baseUrl（或 SEARXNG_BASE_URL 环境变量）。
 */

import { createPlugin } from "@xuancode/plugins";

interface SearXNGResult {
	title?: string;
	url?: string;
	content?: string;
	engine?: string;
}

interface SearXNGResponse {
	query: string;
	number_of_results: number;
	results: SearXNGResult[];
	answers: string[];
	infoboxes: any[];
}

export default createPlugin(
	{
		name: "searxng",
		version: "0.1.0",
		description: "SearXNG 自建搜索引擎 — 连接你的私有搜索实例，零费用",
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

			const baseUrl =
				(ctx.config?.baseUrl as string) || process.env.SEARXNG_BASE_URL;
			if (!baseUrl) {
				return {
					success: false,
					error:
						"SearXNG 地址未配置，请在插件设置中配置 baseUrl，或设置 SEARXNG_BASE_URL 环境变量",
				};
			}

			const num = Math.min(args.num || 5, 20);
			const pageno = args.page || 1;

			try {
				const params = new URLSearchParams({
					q: query,
					format: "json",
					pageno: String(pageno),
					language: (args.language as string) || "zh-CN",
					categories: (args.categories as string) || "general",
				});

				// 去掉尾部斜杠后拼接
				const apiUrl = `${baseUrl.replace(/\/+$/, "")}/search?${params}`;
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 15000);

				const res = await fetch(apiUrl, {
					signal: controller.signal,
					headers: {
						Accept: "application/json",
					},
				});
				clearTimeout(timeout);

				if (!res.ok) {
					return {
						success: false,
						error: `SearXNG 请求失败: ${res.status} ${res.statusText}`,
					};
				}

				const data = (await res.json()) as SearXNGResponse;
				const rawResults = data.results || [];

				const results = rawResults.slice(0, num).map((r) => ({
					title: r.title || "",
					url: r.url || "",
					snippet: r.content || "",
					engine: r.engine || "",
				}));

				return {
					success: true,
					data: {
						results,
						total: data.number_of_results ?? results.length,
						engine: "searxng",
						query,
					},
				};
			} catch (err: any) {
				const msg =
					err.name === "AbortError"
						? "SearXNG 请求超时（15s），请检查服务地址是否正确"
						: `SearXNG 调用异常: ${err.message}`;
				return { success: false, error: msg };
			}
		});

		ctx.log(
			`SearXNG 插件已初始化${process.env.SEARXNG_BASE_URL ? "（已检测到环境变量）" : "，请配置 baseUrl"}`,
		);
	},
);
