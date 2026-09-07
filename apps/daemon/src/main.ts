/**
 * 玄码 Daemon — 生产入口
 *
 * 功能:
 * - 加载 .env 环境变量
 * - 初始化 PluginManager
 * - 启动带安全中间件的 DaemonServer
 * - 优雅关闭 (SIGTERM/SIGINT)
 *
 * 用法: node --import tsx apps/daemon/src/main.ts
 */

import { startDaemonServer } from "./index";

async function main(): Promise<void> {
	// 加载 .env（如果 dotenv 可用）
	try {
		const { config } = await import("dotenv");
		config();
	} catch {
		// dotenv 未安装，跳过
	}

	const port = Number.parseInt(process.env.DAEMON_PORT || "3020", 10);
	const provider = process.env.DAEMON_PROVIDER || "mock";
	const modelName = process.env.DAEMON_MODEL || "deepseek-v4-flash";
	const workDir = process.env.WORK_DIR || process.cwd();
	const sessionsDir = process.env.SESSIONS_DIR;
	const apiKey = process.env.XUANCODE_API_KEY || "";
	const rateLimitRPM = Number.parseInt(
		process.env.DAEMON_RATE_LIMIT || "60",
		10,
	);
	const maxTaskDuration = Number.parseInt(
		process.env.DAEMON_MAX_TASK_DURATION || "600000",
		10,
	);

	console.error("========================================");
	console.error("  玄码 Code Desk — Daemon 生产模式");
	console.error("========================================");
	console.error(`  端口:      ${port}`);
	console.error(`  模型:      ${provider}/${modelName}`);
	console.error(`  工作目录:  ${workDir}`);
	console.error(`  会话目录:  ${sessionsDir || "(默认)"}`);
	console.error(`  API Key:   ${apiKey ? "已配置" : "未配置（无认证）"}`);
	console.error(
		`  速率限制:  ${rateLimitRPM > 0 ? `${rateLimitRPM} req/min` : "不限制"}`,
	);
	console.error(
		`  任务空闲超时: ${Math.round(maxTaskDuration / 1000 / 60)} 分钟（无输出/工具活动才计时，长任务可跑数小时）`,
	);
	console.error("========================================\n");

	const { server, scheduler } = await startDaemonServer({
		port,
		provider,
		modelName,
		workDir,
		sessionsDir,
		apiKey: apiKey || undefined,
		rateLimitRPM,
		maxTaskDuration,
		pluginAutoDiscover: true,
	});

	// 优雅关闭
	const shutdown = async (signal: string) => {
		console.error(`\n[玄码] 收到 ${signal}，正在关闭...`);
		scheduler.stop();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		console.error("[玄码] Daemon 已关闭");
		process.exit(0);
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	const addr = server.address();
	const bindPort = typeof addr === "object" && addr ? addr.port : port;
	console.error(`玄码 Daemon 已启动: http://localhost:${bindPort}\n`);
}

main().catch((err) => {
	console.error("[玄码] 启动失败:", err);
	process.exit(1);
});
