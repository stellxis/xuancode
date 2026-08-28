import { execSync } from "node:child_process";
import { HookEvent } from "@xuancode/types";

/**
 * Hook System — 27+ 事件节点覆盖全生命周期
 *
 * Inspired by Claude Code's hook architecture:
 * 4 execution types: command, prompt, http, agent
 */

export type HookExecution = "command" | "prompt" | "http" | "agent";

export interface HookDefinition {
	event: HookEvent;
	name: string;
	execution: HookExecution;
	command?: string;
	prompt?: string;
	url?: string;
	agent?: string;
	timeout?: number;
}

export interface HookContext {
	event: HookEvent;
	timestamp: number;
	turn?: number;
	toolType?: string;
	toolParams?: Record<string, string | undefined>;
	toolResult?: { success: boolean; data?: string; error?: string };
	subAgentType?: string;
	subAgentTask?: string;
}

export interface HookResult {
	handled: boolean;
	action?: "continue" | "stop" | "retry" | "skip";
	message?: string;
	modifications?: Partial<HookContext>;
}

/**
 * Hook Registry — manages registered hooks
 */
export class HookRegistry {
	private hooks: Map<HookEvent, HookDefinition[]> = new Map();
	private hookHistory: Array<{
		event: HookEvent;
		result: HookResult;
		duration: number;
	}> = [];

	/**
	 * Register a hook for a specific event
	 */
	register(hook: HookDefinition): void {
		const existing = this.hooks.get(hook.event) || [];
		existing.push(hook);
		this.hooks.set(hook.event, existing);
	}

	/**
	 * Execute all hooks for a given event
	 */
	async execute(event: HookEvent, context: HookContext): Promise<HookResult[]> {
		const definitions = this.hooks.get(event) || [];
		const results: HookResult[] = [];

		for (const def of definitions) {
			const start = performance.now();
			try {
				const result = await this.executeSingle(def, context);
				results.push(result);
				this.hookHistory.push({
					event,
					result,
					duration: performance.now() - start,
				});
			} catch (err: any) {
				results.push({
					handled: false,
					message: `Hook执行失败: ${err.message}`,
				});
			}
		}

		return results;
	}

	/**
	 * Get all registered events
	 */
	getRegisteredEvents(): HookEvent[] {
		return Array.from(this.hooks.keys());
	}

	/**
	 * Get hook execution history
	 */
	getHistory(): Array<{
		event: HookEvent;
		result: HookResult;
		duration: number;
	}> {
		return [...this.hookHistory];
	}

	private async executeSingle(
		def: HookDefinition,
		context: HookContext,
	): Promise<HookResult> {
		switch (def.execution) {
			case "command":
				return this.executeCommand(def, context);
			case "prompt":
				return this.executePrompt(def, context);
			case "http":
				return this.executeHttp(def, context);
			case "agent":
				return this.executeAgent(def, context);
			default:
				return { handled: false, message: `未知执行类型: ${def.execution}` };
		}
	}

	private async executeCommand(
		def: HookDefinition,
		context: HookContext,
	): Promise<HookResult> {
		if (!def.command) return { handled: false, message: "命令为空" };
		try {
			// Replace template variables
			const cmd = def.command
				.replace(/\{\{toolType\}\}/g, context.toolType || "")
				.replace(/\{\{success\}\}/g, String(context.toolResult?.success ?? ""))
				.replace(/\{\{timestamp\}\}/g, String(Date.now()));

			const output = execSync(cmd, {
				encoding: "utf-8",
				stdio: "pipe",
				timeout: def.timeout || 5000,
				windowsHide: true,
			});
			return { handled: true, message: output.trim() };
		} catch (err: any) {
			return { handled: false, message: `命令执行失败: ${err.message}` };
		}
	}

	private async executePrompt(
		def: HookDefinition,
		context: HookContext,
	): Promise<HookResult> {
		if (!def.prompt) return { handled: false, message: "提示为空" };
		// In production, evaluates prompt with LLM
		return { handled: true, message: `提示钩子: ${context.event}` };
	}

	private async executeHttp(
		def: HookDefinition,
		context: HookContext,
	): Promise<HookResult> {
		if (!def.url) return { handled: false, message: "URL为空" };
		// In production, sends webhook
		return { handled: true, message: `WebHook: ${def.url}` };
	}

	private async executeAgent(
		def: HookDefinition,
		context: HookContext,
	): Promise<HookResult> {
		// In production, spawns verification agent
		return { handled: true, message: `子Agent验证: ${def.agent}` };
	}
}

/**
 * Create default hook set
 */
export function createDefaultHooks(): HookDefinition[] {
	return [
		{
			event: HookEvent.PRE_TOOL_USE,
			name: "pre-tool-log",
			execution: "command",
			command: "echo 'PreToolUse: {{toolType}}' >> .xuancode/hooks.log",
		},
		{
			event: HookEvent.POST_TOOL_USE,
			name: "post-tool-log",
			execution: "command",
			command:
				"echo 'PostToolUse: {{toolType}} ({{success}})' >> .xuancode/hooks.log",
		},
		{
			event: HookEvent.SESSION_START,
			name: "session-start",
			execution: "command",
			command:
				"echo 'Session started at {{timestamp}}' >> .xuancode/session.log",
		},
	];
}
