/**
 * 玄码 SERPAPI 网页搜索插件
 * 五行分类: 水 (water) — 网络/数据/API
 *
 * 提供 web_search 工具，通过 SERPAPI 获取搜索引擎结果。
 * 需要配置 apiKey（或 SERPAPI_API_KEY 环境变量）。
 */

import { createPlugin } from "@xuancode/plugins";

export default createPlugin(
	{
		name: "serpapi",
		version: "0.1.0",
		description: "SERPAPI 网页搜索 — 支持 Google/Bing/Baidu 等搜索引擎",
		author: "玄码",
		element: "water",
		events: [],
	},
	async (ctx, api) => {
		if (!api.registerTool) throw new Error("当前插件宿主不支持 registerTool");
		api.registerTool("web_search", async (args: any) => {
			const apiKey =
				(ctx.config?.apiKey as string) || process.env.SERPAPI_API_KEY;
			if (!apiKey) {
				return {
					success: false,
					error: "SERPAPI_API_KEY 未配置，请在插件设置中配置 apiKey",
				};
			}

			const query = args.query || args.q;
			if (!query) {
				return { success: false, error: "缺少必填参数: query" };
			}

			const engine = args.engine || "google";
			const num = Math.min(args.num || 5, 20);

			try {
				const params = new URLSearchParams({
					q: query,
					api_key: apiKey,
					engine,
					num: String(num),
				});

				const res = await fetch(`https://serpapi.com/search?${params}`);
				if (!res.ok) {
					return {
						success: false,
						error: `SERPAPI 请求失败: ${res.status} ${res.statusText}`,
					};
				}

				const data: any = await res.json();
				if (data.error) {
					return { success: false, error: data.error };
				}

				const results = (data.organic_results || [])
					.slice(0, num)
					.map((r: any) => ({
						title: r.title || "",
						url: r.link || "",
						snippet: r.snippet || "",
					}));

				return {
					success: true,
					data: {
						results,
						total: data.search_information?.total_results,
						engine,
						query,
					},
				};
			} catch (err: any) {
				return { success: false, error: `SERPAPI 调用异常: ${err.message}` };
			}
		});

		ctx.log(
			`SERPAPI 插件已初始化 (engine: google, 环境变量: ${process.env.SERPAPI_API_KEY ? "已配置" : "未配置"})`,
		);
	},
);
