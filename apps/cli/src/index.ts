#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

// Auto-load .env file — search upward from cwd for project root
function loadEnv(): void {
	let dir = process.cwd();
	for (let i = 0; i < 5; i++) {
		try {
			const envPath = path.join(dir, ".env");
			if (fs.existsSync(envPath)) {
				const content = fs.readFileSync(envPath, "utf-8");
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith("#")) continue;
					const eqIdx = trimmed.indexOf("=");
					if (eqIdx === -1) continue;
					const key = trimmed.slice(0, eqIdx).trim();
					const value = trimmed.slice(eqIdx + 1).trim();
					if (key && !process.env[key]) process.env[key] = value;
				}
				return;
			}
		} catch {
			/* skip */
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}
loadEnv();

// Detect project root
function findProjectRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 5; i++) {
		if (fs.existsSync(path.join(dir, ".env"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	dir = process.cwd();
	for (let i = 0; i < 5; i++) {
		if (
			fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
			(fs.existsSync(path.join(dir, "package.json")) &&
				fs.existsSync(path.join(dir, "pnpm-lock.yaml")))
		)
			return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();

// ===== SQLite 持久化 =====
const SQLITE_DB_PATH = path.join(PROJECT_ROOT, ".xuancode", "sessions.db");
let sessionPersistence: SessionPersistence | null = null;

import readline from "node:readline";
import type { ModelAdapter } from "@xuancode/model-adapter";
import type { Message } from "@xuancode/types";
import { program } from "commander";
import { render } from "ink";
import React from "react";
import App from "./ink/App";

import { API_VERSION } from "@xuancode/daemon-protocol";
import { SessionPersistence } from "@xuancode/database";
import { shouldAutoPromoteToPlan, wrapPlanPrompt } from "./commands/plan";
import { renderMarkdownToChalk } from "./components/markdown";
import { DaemonClient } from "./daemonClient";
import {
	type SessionRecord,
	buildConversationSummarySimple,
	createSessionStore,
} from "./session";

const SESSION_FILE = path.join(
	PROJECT_ROOT,
	".xuancode",
	"xuancode-sessions.jsonl",
);

const sessionStore = createSessionStore(SESSION_FILE);
const { saveSession, clearSessions, loadLastSession } = sessionStore;
export type { SessionRecord };

// ===== CLI 参数 =====

// 构建时由 tsup define 注入（单点版本源 package.json），见 tsup.config.ts；
// dev 模式（tsx 直跑不经过 define）用 typeof 兜底为 dev 版本，避免 ReferenceError
declare const __XUANCODE_VERSION__: string;
const XUANCODE_VERSION =
	typeof __XUANCODE_VERSION__ === "string" ? __XUANCODE_VERSION__ : "0.0.0-dev";

program
	.name("xuancode")
	.description("玄码 Code Desk — 国风科技智能编码中枢")
	.version(XUANCODE_VERSION)
	.option(
		"-m, --mode <mode>",
		"信任模式 (plan|default|trust|auto|bypass)",
		"default",
	)
	.option(
		"-p, --provider <provider>",
		"模型供应商 (deepseek|qwen|mock)",
		"mock",
	)
	.option("--model <model>", "模型名称", "deepseek-v4-flash")
	.option("--max-turns <turns>", "最大执行轮次", "30")
	.option(
		"--max-continuations <n>",
		"达到最大轮次后自动续跑次数 (默认 0=不续跑)",
		"0",
	)
	.option(
		"--compact-level <level>",
		"上下文压缩等级 0-4 (关=0, 剪=1, 微=2, 坍=3, 自=4)",
		"1",
	)
	.option(
		"-c, --connect [url]",
		"连接到运行中的 Daemon (默认 http://localhost:3020)",
	);

// ===== daemon 子命令（隐藏）：由 main() 按 argv 处理（内嵌启动 / npm client-only 降级） =====

program
	.command("daemon", { hidden: true })
	.description("启动内嵌 Daemon")
	.action(() => {
		/* 实际逻辑在 main() 中按 argv[0]==="daemon" 处理 */
	});

// ===== plan <task> subcommand =====

program
	.command("plan <task>")
	.description("制定并执行多步骤实施计划")
	.option(
		"--connect [url]",
		"连接到运行中的 Daemon (默认 http://localhost:3020)",
	)
	.action(async (task: string, cmdOpts: Record<string, any>) => {
		const planConnectUrl = cmdOpts.connect;
		let planDaemonClient: DaemonClient | undefined;

		if (planConnectUrl !== undefined) {
			const daemonBaseUrl =
				typeof planConnectUrl === "string"
					? planConnectUrl.replace(/\/+$/, "")
					: "http://localhost:3020";
			planDaemonClient = new DaemonClient({ baseUrl: daemonBaseUrl });
			const healthy = await planDaemonClient.checkHealth();
			if (!healthy) {
				console.error(`错误: 无法连接到 Daemon (${daemonBaseUrl})`);
				console.error("请先启动 Daemon: xuancode daemon");
				process.exit(1);
			}
		} else {
			const currentOpts = (program as any).opts();
			const effectiveProvider = currentOpts?.provider || "mock";
			if (
				effectiveProvider !== "mock" &&
				!process.env.DEEPSEEK_API_KEY &&
				!process.env.OPENAI_API_KEY
			) {
				console.error(
					"错误: 未配置模型 API Key。请设置环境变量或使用 --connect 连接到 Daemon。",
				);
				process.exit(1);
			}
		}

		const PlanApp = (await import("./ink/PlanApp")).default;
		const planOpts = program.opts();
		const { waitUntilExit } = render(
			React.createElement(PlanApp, {
				task,
				daemonClient: planDaemonClient,
				workDir: PROJECT_ROOT,
				opts: {
					mode: planOpts.mode,
					provider: planOpts.provider,
					modelName: planOpts.model,
					maxTurns: Number.parseInt(planOpts.maxTurns, 10),
					maxContinuations: Number.parseInt(planOpts.maxContinuations, 10),
					compactLevel: Number.parseInt(planOpts.compactLevel, 10),
				},
			}),
		);
		await waitUntilExit();
	});

// Strip tsx/node script path from argv (tsx passes src/index.ts as argument)
const argv = process.argv
	.slice(2)
	.filter(
		(a) =>
			a !== "--" &&
			!a.endsWith(".ts") &&
			!a.endsWith(".js") &&
			!a.endsWith(".mjs"),
	);
if (argv.length > 0) {
	program.parse(argv, { from: "user" });
}

const opts = program.opts();

// Auto-detect provider from env vars
const hasExplicitProvider = argv.some((a) => a === "-p" || a === "--provider");
if (!hasExplicitProvider) {
	if (process.env.DEEPSEEK_API_KEY) {
		opts.provider = "deepseek";
	}
}

// ===== Non-Interactive Mode (piped stdin / non-TTY) =====

async function runNonInteractive(
	model: ModelAdapter,
	workDir: string,
	cmdOpts: Record<string, any>,
	saveSessionFn: typeof saveSession,
	previousSessionContext: string | null,
): Promise<void> {
	const lines: string[] = [];
	const rl = readline.createInterface({ input: process.stdin });

	for await (const line of rl) {
		const trimmed = line.trim();
		if (trimmed) lines.push(trimmed);
	}

	const maxTurns = Number.parseInt(cmdOpts.maxTurns, 10);
	const compactLevel = Number.parseInt(cmdOpts.compactLevel, 10);
	let threadMessages: Message[] = [];

	for (const input of lines) {
		// 用文本摘要替代原始 Message[]，避免干扰 stopConditions
		const prevSummary = buildConversationSummarySimple(threadMessages);
		const contextualInput = [
			previousSessionContext ? `[历史对话]\n${previousSessionContext}` : "",
			prevSummary ? `[上轮对话]\n${prevSummary}` : "",
			`[当前问题]\n${input}`,
		]
			.filter(Boolean)
			.join("\n\n");

		// /plan 输入或长任务信号 → 启用工作流（与交互模式 shouldAutoPromoteToPlan 一致）
		const isPlanCmd = input.startsWith("/plan ");
		const enableWorkflow = isPlanCmd || shouldAutoPromoteToPlan(input);
		const taskInput = isPlanCmd
			? wrapPlanPrompt(input.slice(6).trim())
			: contextualInput;

		try {
			const { runTaorLoop } = await import("@xuancode/orchestrator");
			const result = await runTaorLoop(taskInput, {
				model,
				workDir,
				enableWorkflow,
				config: {
					mode: cmdOpts.mode as any,
					maxTurns,
					maxContinuations: Number.parseInt(cmdOpts.maxContinuations, 10),
					compactLevel,
					compactThreshold: 0.7,
				},
				onTurn: (t, state) => {
					threadMessages = (state as any)?.messages || [];
				},
				onToolCall: () => {},
				onError: () => {},
			});

			const mdOutput = renderMarkdownToChalk(result.finalAnswer || "");
			console.log(mdOutput);

			saveSessionFn({
				timestamp: Date.now(),
				userInput: input,
				finalAnswer: (result.finalAnswer || "").slice(0, 2000),
				turnCount: result.turnCount,
				toolCallCount: result.toolCallCount,
			});
		} catch (err) {
			console.error(`处理失败: ${input}`, err);
		}
	}
}

// ===== Non-Interactive Mode (Connect) =====

async function runNonInteractiveConnect(
	daemonClient: DaemonClient,
	cmdOpts: Record<string, any>,
	saveSessionFn: typeof saveSession,
	previousSessionContext: string | null,
): Promise<void> {
	const lines: string[] = [];
	const rl = readline.createInterface({ input: process.stdin });

	for await (const line of rl) {
		const trimmed = line.trim();
		if (trimmed) lines.push(trimmed);
	}

	const maxTurns = Number.parseInt(cmdOpts.maxTurns, 10);
	const compactLevel = Number.parseInt(cmdOpts.compactLevel, 10);
	const sessionId = `ni-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	for (const input of lines) {
		const contextualInput = previousSessionContext
			? `[历史对话]\n${previousSessionContext}\n\n[当前问题]\n${input}`
			: input;

		// /plan 输入或长任务信号 → 启用工作流（与交互模式 shouldAutoPromoteToPlan 一致）
		const isPlanCmd = input.startsWith("/plan ");
		const enableWorkflow = isPlanCmd || shouldAutoPromoteToPlan(input);
		const taskInput = isPlanCmd
			? wrapPlanPrompt(input.slice(6).trim())
			: contextualInput;

		try {
			const result = await daemonClient.runTask(
				taskInput,
				{
					mode: cmdOpts.mode as any,
					maxTurns,
					maxContinuations: Number.parseInt(cmdOpts.maxContinuations, 10),
					compactLevel,
					compactThreshold: 0.7,
					sessionId,
					...(enableWorkflow ? { enableWorkflow: true } : {}),
				},
				{
					onToken: () => {},
					onToolCall: () => {},
					onError: () => {},
				},
			);

			const mdOutput = renderMarkdownToChalk(result.finalAnswer || "");
			console.log(mdOutput);

			saveSessionFn({
				timestamp: Date.now(),
				userInput: input,
				finalAnswer: (result.finalAnswer || "").slice(0, 2000),
				turnCount: result.turnCount,
				toolCallCount: result.toolCallCount,
			});
		} catch (err) {
			console.error(`处理失败: ${input}`, err);
		}
	}
}

// ===== 入口 =====

async function main() {
	// plan subcommand is handled by commander's .command("plan <task>").action()
	if (argv.includes("plan")) return;

	// ── SQLite 初始化（非阻塞，失败不影响主流程）──
	(async () => {
		try {
			const p = new SessionPersistence(SQLITE_DB_PATH);
			await p.initialize();
			sessionPersistence = p;
		} catch (e) {
			// SQLite 初始化失败不影响主流程
		}
	})();

	// ── Daemon subcommand ──
	if (argv[0] === "daemon" || argv[1] === "daemon") {
		try {
			// @ts-ignore — daemon 为可选外部依赖：公开/client-only 构建下此包不存在，运行时由 try/catch 兜底
			const { startDaemonServer } = await import("@xuancode/daemon");
			const daemonOpts = {
				port: Number.parseInt(process.env.DAEMON_PORT || "3020", 10),
				provider: opts.provider,
				modelName: opts.model,
				workDir: PROJECT_ROOT,
			};
			const { server } = await startDaemonServer(daemonOpts);
			const addr = server.address();
			const port =
				typeof addr === "object" && addr ? addr.port : daemonOpts.port;
			console.error(`玄码 Daemon 启动于 http://localhost:${port}`);
		} catch {
			// npm 版 CLI 为 client-only，不内置 daemon；源码/pnpm/二进制版本仍走内嵌
			console.error("npm 版 CLI 不内置 Daemon（client-only 模式）。");
			console.error(
				"请使用 Desktop 内置 daemon、Docker 镜像，或从源码安装内嵌版本。",
			);
			console.error("然后使用: xuancode --connect http://localhost:3020");
			process.exit(1);
		}
		return;
	}

	// ── Connect mode (--connect) ──
	const connectUrl = opts.connect;
	if (connectUrl !== undefined) {
		const daemonBaseUrl =
			typeof connectUrl === "string"
				? connectUrl.replace(/\/+$/, "")
				: "http://localhost:3020";

		const daemonClient = new DaemonClient({ baseUrl: daemonBaseUrl });

		const healthy = await daemonClient.checkHealth();
		if (!healthy) {
			console.error(`错误: 无法连接到 Daemon (${daemonBaseUrl})`);
			console.error("请先启动 Daemon: xuancode daemon");
			process.exit(1);
		}

		// 协议版本协商：不兼容则明确提示升级，而非静默出错
		const compat = await daemonClient.ensureCompatible();
		if (!compat.ok) {
			if (compat.needsUpgrade === "client") {
				console.error(
					`协议版本不兼容：daemon 为 API v${compat.serverApiVersion}，当前 CLI 仅支持到 v${API_VERSION}。`,
				);
				console.error("请升级 CLI: npm install -g @xuancode/cli");
			} else {
				console.error(
					`协议版本不兼容：daemon API v${compat.serverApiVersion} 已过旧（当前 CLI 要求 v${API_VERSION} 及以上）。`,
				);
				console.error("请升级/重启 Daemon。");
			}
			process.exit(1);
		}

		const previousSessionContext = loadLastSession();

		if (process.stdin.isTTY) {
			// Interactive connect mode
			(globalThis as any).__xuancode_saveSession = saveSession;
			(globalThis as any).__xuancode_clearSessions = clearSessions;
			(globalThis as any).__xuancode_sessionPersistence = sessionPersistence;
			(globalThis as any).__xuancode_previousSessionContext =
				previousSessionContext;

			const { waitUntilExit } = render(
				React.createElement(App, {
					daemonClient,
					workDir: PROJECT_ROOT,
					opts: {
						mode: opts.mode,
						provider: opts.provider,
						modelName: opts.model,
						maxTurns: Number.parseInt(opts.maxTurns, 10),
						maxContinuations: Number.parseInt(opts.maxContinuations, 10),
						compactLevel: Number.parseInt(opts.compactLevel, 10),
					},
				}),
			);

			await waitUntilExit();
		} else {
			await runNonInteractiveConnect(
				daemonClient,
				opts,
				saveSession,
				previousSessionContext,
			);
			process.exit(0);
		}
		return;
	}

	const { createModelAdapter } = await import("@xuancode/model-adapter");
	const model = createModelAdapter(opts.provider, {
		modelName: opts.model,
	});

	const previousSessionContext = loadLastSession();

	// Interactive mode (TTY) -> Ink UI; Non-TTY -> batch processing
	if (process.stdin.isTTY) {
		// Expose to Ink app via globalThis (refactor later)
		(globalThis as any).__xuancode_saveSession = saveSession;
		(globalThis as any).__xuancode_clearSessions = clearSessions;
		(globalThis as any).__xuancode_previousSessionContext =
			previousSessionContext;

		const { waitUntilExit } = render(
			React.createElement(App, {
				model,
				workDir: PROJECT_ROOT,
				opts: {
					mode: opts.mode,
					provider: opts.provider,
					modelName: opts.model,
					maxTurns: Number.parseInt(opts.maxTurns, 10),
					maxContinuations: Number.parseInt(opts.maxContinuations, 10),
					compactLevel: Number.parseInt(opts.compactLevel, 10),
				},
			}),
		);

		await waitUntilExit();
	} else {
		// Non-TTY: batch process piped input
		await runNonInteractive(
			model,
			PROJECT_ROOT,
			opts,
			saveSession,
			previousSessionContext,
		);
		process.exit(0);
	}
}

main().catch(console.error);
