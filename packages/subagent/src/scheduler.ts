import type { ModelAdapter } from "@xuancode/model-adapter";
import { runTaorLoop } from "@xuancode/orchestrator";
import { type AgentMode, HookEvent, type SubAgentType } from "@xuancode/types";
import { HookRegistry, createDefaultHooks } from "./hooks/hookSystem";
import { WorktreeManager } from "./worktree";

/**
 * Sub-Agent Scheduler — manages delegation to specialized agents
 *
 * Supports 3 execution modes:
 * - sync: main agent waits for sub-agent to complete
 * - background: sub-agent runs in background (fire-and-forget)
 * - worktree: sub-agent runs in isolated git worktree
 */

export type ExecutionMode = "sync" | "background" | "worktree";
export type ModelFactory = (type: SubAgentType) => ModelAdapter;

export interface SubAgentTask {
	id: string;
	type: SubAgentType;
	mode: ExecutionMode;
	instruction: string;
	startedAt?: number;
	completedAt?: number;
	result?: string;
	error?: string;
}

/** Agent-specific configuration */
interface AgentProfile {
	mode: AgentMode;
	maxTurns: number;
	purpose: string;
	tools: string[];
	systemPrompt: string;
}

const AGENT_PROFILES: Record<SubAgentType, AgentProfile> = {
	explore: {
		mode: "plan",
		maxTurns: 8,
		purpose: "代码搜索与理解 — 只读探索代码库",
		tools: ["read_file", "list_dir", "glob", "grep", "web_search", "web_fetch"],
		systemPrompt: `你是玄码 · 探 — 只读探索 Agent。

## 核心原则
- 你只能执行读取操作，绝不能修改任何文件
- 你的任务：快速理解代码库结构，搜索相关文件，提取关键信息
- 完成搜索后，给出简洁的发现总结（文件结构、关键函数、数据流）

## 输出格式
\`\`\`
## 探索结果
- 项目概览：[1-2句]
- 关键文件：[发现的文件列表]
- 核心逻辑：[发现的关键逻辑/函数]
- 建议：[如果适用]
\`\`\``,
	},
	plan: {
		mode: "plan",
		maxTurns: 10,
		purpose: "方案设计 — 分析需求并制定实施计划",
		tools: ["read_file", "list_dir", "glob", "grep"],
		systemPrompt: `你是玄码 · 策 — 方案设计 Agent。

## 核心原则
- 你只能执行读取操作，绝不能修改任何文件
- 你的任务：分析需求，评估代码库现状，制定详细的实施计划

## 输出格式
\`\`\`
## 设计方案
### 需求分析
[需求理解]

### 现有代码评估
[相关代码分析]

### 实施步骤
1. [步骤1]
2. [步骤2]
...

### 风险与缓解
- [风险1] → [缓解方案]
\`\`\``,
	},
	implement: {
		mode: "default",
		maxTurns: 15,
		purpose: "代码实现 — 执行编码任务",
		tools: [
			"read_file",
			"write_file",
			"edit_file",
			"list_dir",
			"shell",
			"glob",
			"grep",
		],
		systemPrompt: `你是玄码 · 匠 — 编码实现 Agent。

## 核心原则
- 你有完整工具权限，请谨慎操作
- 你的任务：根据设计方案执行编码任务
- 每完成一个文件修改后，验证改动是否正确
- 完成后给出变更总结

## 输出格式
\`\`\`
## 变更总结
- 修改的文件：[列表]
- 新增的文件：[列表]
- 验证结果：[测试/编译结果]
\`\`\``,
	},
	review: {
		mode: "plan",
		maxTurns: 10,
		purpose: "代码审查 — 检查代码质量和安全性",
		tools: ["read_file", "list_dir", "glob", "grep"],
		systemPrompt: `你是玄码 · 鉴 — 代码审查 Agent。

## 核心原则
- 你只能读取文件，不能修改任何代码
- 你的任务：审查代码变更，检查代码质量、安全性、性能

## 审查维度
1. 代码质量：命名、结构、重复、复杂度
2. 安全性：注入、越权、敏感信息
3. 性能：算法复杂度、不必要的操作
4. 可维护性：注释、文档、测试覆盖

## 输出格式
\`\`\`
## 审查报告
### 严重问题
- [问题] → [建议修复方案]

### 建议改进
- [建议] → [改进方案]

### 总结
[总体评价]
\`\`\``,
	},
	security: {
		mode: "auto",
		maxTurns: 12,
		purpose: "安全审计 — 检测漏洞和安全风险",
		tools: ["read_file", "list_dir", "glob", "grep", "shell"],
		systemPrompt: `你是玄码 · 卫 — 安全审计 Agent。

## 核心原则
- 你有完整工具权限以进行深入检查
- 你的任务：检测代码中的安全漏洞、配置错误、敏感信息泄露

## 审计维度
1. 注入攻击：SQL/XSS/命令注入
2. 认证授权：越权、会话管理
3. 敏感信息：硬编码密钥、凭证泄露
4. 配置安全：CORS、HTTPS、CSP
5. 依赖安全：已知漏洞版本

## 输出格式
\`\`\`
## 安全审计报告
### 高危 (CVSS 7-10)
- [漏洞] → [位置] → [修复方案]

### 中危 (CVSS 4-6.9)
- [漏洞] → [位置] → [修复方案]

### 低危 (CVSS 0-3.9)
- [问题] → [建议]

### 总结
[总体安全评估]
\`\`\``,
	},
	test: {
		mode: "auto",
		maxTurns: 15,
		purpose: "测试编写与执行 — 编写并运行测试用例",
		tools: [
			"read_file",
			"write_file",
			"edit_file",
			"list_dir",
			"shell",
			"glob",
			"grep",
		],
		systemPrompt: `你是玄码 · 测 — 测试 Agent。

## 核心原则
- 你有完整工具权限
- 你的任务：分析已有代码，编写测试用例并运行验证
- 优先使用项目已有的测试框架和约定

## 工作流程
1. 阅读待测代码，理解逻辑
2. 查看已有测试，遵循项目约定
3. 编写单元/集成测试用例
4. 执行测试，确保通过
5. 修复失败的测试

## 输出格式
\`\`\`
## 测试报告
- 覆盖的文件：[列表]
- 新增测试：[数量]
- 运行结果：[通过/失败]
- 覆盖率预估：[百分比]
\`\`\``,
	},
	docs: {
		mode: "plan",
		maxTurns: 10,
		purpose: "文档编写 — 生成与维护项目文档",
		tools: ["read_file", "write_file", "edit_file", "list_dir", "glob", "grep"],
		systemPrompt: `你是玄码 · 文 — 文档 Agent。

## 核心原则
- 你的任务：编写清晰、结构化的文档
- 遵循项目已有的文档风格

## 文档类型
1. API 文档：接口说明、参数、返回值
2. 架构文档：模块关系、数据流
3. README / 使用指南：快速上手
4. 变更日志：版本更新记录

## 输出格式
\`\`\`
## 文档变更
- 创建/修改的文件：[列表]
- 文档类型：[类型]
- 主要内容：[概要]
\`\`\``,
	},
	debug: {
		mode: "auto",
		maxTurns: 12,
		purpose: "调试诊断 — 排查 Bug 和异常问题",
		tools: [
			"read_file",
			"edit_file",
			"list_dir",
			"shell",
			"glob",
			"grep",
			"web_search",
			"web_fetch",
		],
		systemPrompt: `你是玄码 · 调 — 调试 Agent。

## 核心原则
- 你有完整工具权限
- 你的任务：定位并修复代码中的 Bug

## 工作流程
1. 复现问题：了解错误表现
2. 定位根因：阅读相关代码，添加调试输出
3. 制定修复方案
4. 实施修复并验证

## 输出格式
\`\`\`
## 诊断报告
- 问题描述：[错误表现]
- 根因分析：[原因]
- 修复方案：[具体改动]
- 验证结果：[修复后确认]
\`\`\``,
	},
};

export class SubAgentScheduler {
	private tasks: Map<string, SubAgentTask> = new Map();
	private taskCounter = 0;
	private modelFactory: ModelFactory;
	private workDir: string;
	private hookRegistry: HookRegistry;
	private backgroundTasks: Map<string, Promise<string>> = new Map();

	constructor(modelFactory: ModelFactory, workDir: string) {
		this.modelFactory = modelFactory;
		this.workDir = workDir;
		this.hookRegistry = new HookRegistry();
		// Register default hooks
		for (const hook of createDefaultHooks(workDir)) {
			this.hookRegistry.register(hook);
		}
	}

	/** Access the hook registry for custom hook registration */
	getHookRegistry(): HookRegistry {
		return this.hookRegistry;
	}

	/**
	 * Delegate a task to a sub-agent
	 */
	async delegate(
		type: SubAgentType,
		instruction: string,
		mode: ExecutionMode = "sync",
	): Promise<string> {
		const id = `sub-${++this.taskCounter}-${type}`;
		const task: SubAgentTask = {
			id,
			type,
			mode,
			instruction,
			startedAt: Date.now(),
		};

		this.tasks.set(id, task);

		await this.hookRegistry.execute(HookEvent.SUBAGENT_START, {
			event: HookEvent.SUBAGENT_START,
			timestamp: Date.now(),
			subAgentType: type,
			subAgentTask: instruction.slice(0, 100),
		});

		try {
			const result = await this.executeTask(task);
			task.result = result;
			task.completedAt = Date.now();

			await this.hookRegistry.execute(HookEvent.SUBAGENT_STOP, {
				event: HookEvent.SUBAGENT_STOP,
				timestamp: Date.now(),
				subAgentType: type,
				subAgentTask: id,
			});

			return result;
		} catch (err: any) {
			task.error = err.message;
			task.completedAt = Date.now();
			throw err;
		}
	}

	/**
	 * Get the result of a specific task
	 */
	getTask(id: string): SubAgentTask | undefined {
		return this.tasks.get(id);
	}

	/**
	 * Get all completed tasks
	 */
	getCompletedTasks(): SubAgentTask[] {
		return Array.from(this.tasks.values()).filter((t) => t.completedAt);
	}

	/**
	 * Get tasks of a specific type
	 */
	getTasksByType(type: SubAgentType): SubAgentTask[] {
		return Array.from(this.tasks.values()).filter((t) => t.type === type);
	}

	/**
	 * Wait for all background tasks to complete
	 */
	async waitForAll(): Promise<Map<string, string>> {
		const results = new Map<string, string>();
		for (const [id, promise] of this.backgroundTasks) {
			try {
				results.set(id, await promise);
			} catch (err: any) {
				results.set(id, `错误: ${err.message}`);
			}
		}
		return results;
	}

	// ─── Internal ───

	private async executeTask(task: SubAgentTask): Promise<string> {
		switch (task.mode) {
			case "sync":
				return this.executeSync(task);
			case "background":
				return this.executeBackground(task);
			case "worktree":
				return this.executeWithWorktree(task);
			default:
				return this.executeSync(task);
		}
	}

	private async executeSync(task: SubAgentTask): Promise<string> {
		const profile = AGENT_PROFILES[task.type];
		const model = this.modelFactory(task.type);

		const result = await runTaorLoop(task.instruction, {
			model,
			workDir: this.workDir,
			config: {
				mode: profile.mode,
				maxTurns: profile.maxTurns,
				compactLevel: 1,
				compactThreshold: 0.7,
			},
			systemPrompt: profile.systemPrompt,
			onHook: (event, ctx) => {
				this.hookRegistry
					.execute(event as HookEvent, {
						event: event as HookEvent,
						timestamp: Date.now(),
						...ctx,
					})
					.catch(() => {});
			},
		});

		return result.finalAnswer;
	}

	private async executeBackground(task: SubAgentTask): Promise<string> {
		// Track the promise for later collection
		const promise = this.executeSync(task)
			.then((result) => {
				task.result = result;
				task.completedAt = Date.now();
				// Fire SUBAGENT_STOP hook on completion
				this.hookRegistry
					.execute(HookEvent.SUBAGENT_STOP, {
						event: HookEvent.SUBAGENT_STOP,
						timestamp: Date.now(),
						subAgentType: task.type,
						subAgentTask: task.id,
					})
					.catch(() => {});
				return result;
			})
			.catch((err: Error) => {
				task.error = err.message;
				task.completedAt = Date.now();
				return `[后台错误] ${err.message}`;
			});

		this.backgroundTasks.set(task.id, promise);
		// Return structured JSON so the caller can track the task
		return JSON.stringify({
			taskId: task.id,
			type: task.type,
			message: `[后台] 任务 ${task.id} 已启动 (${task.type})`,
			status: "started",
		});
	}

	private async executeWithWorktree(task: SubAgentTask): Promise<string> {
		const profile = AGENT_PROFILES[task.type];
		const model = this.modelFactory(task.type);
		const wm = new WorktreeManager();

		const worktreePath = await wm.create({
			baseDir: this.workDir,
			cleanupOnComplete: true,
		});

		try {
			const result = await runTaorLoop(task.instruction, {
				model,
				workDir: worktreePath,
				config: {
					mode: profile.mode,
					maxTurns: profile.maxTurns,
				},
				systemPrompt: `[工作台隔离]\n${profile.systemPrompt}`,
				onHook: (event, ctx) => {
					this.hookRegistry
						.execute(event as HookEvent, {
							event: event as HookEvent,
							timestamp: Date.now(),
							...ctx,
						})
						.catch(() => {});
				},
			});

			return result.finalAnswer;
		} finally {
			await wm.cleanupAll();
		}
	}
}

/**
 * Get agent-specific instructions (backward compat)
 */
export function getAgentInstructions(type: SubAgentType): {
	purpose: string;
	tools: string[];
	mode: AgentMode;
} {
	const profile = AGENT_PROFILES[type];
	return {
		purpose: profile.purpose,
		tools: profile.tools,
		mode: profile.mode,
	};
}

export const SUB_AGENT_TYPES: SubAgentType[] = [
	"explore",
	"plan",
	"implement",
	"review",
	"security",
	"test",
	"docs",
	"debug",
];
