/**
 * 玄码插件系统 — 五行分类插件注册与生命周期管理
 *
 * 插件类型按五行分类:
 * - 金 (metal): 文件系统/存储相关
 * - 木 (wood):  代码理解/分析相关
 * - 水 (water):  网络/数据/API 相关
 * - 火 (fire):   执行/构建/部署相关
 * - 土 (earth):  协作/Agent 相关
 */

import type { ElementType, ToolDefinition } from "@xuancode/types";

// ===== 事件类型 =====

export type PluginEvent =
	| "onLoad"
	| "onUnload"
	| "onToolCall"
	| "onToolResult"
	| "onSessionStart"
	| "onSessionEnd"
	| "onError";

// ===== 插件定义 =====

export interface PluginManifest {
	name: string;
	version: string;
	description: string;
	author?: string;
	element: ElementType;
	events: PluginEvent[];
}

export interface PluginContext {
	workDir: string;
	sessionId?: string;
	config: Record<string, unknown>;
	log: (msg: string) => void;
	/** 注册插件卸载时的副作用清理函数（unregister 时按逆序执行） */
	onUnload?: (cb: () => void) => void;
}

/** 插件注册工具时提供的定义（简化版，适配外部插件场景） */
export interface ToolRegistration {
	description: string;
	parameters: Array<{
		name: string;
		type: "string" | "number" | "boolean" | "array" | "object";
		description: string;
		required: boolean;
		default?: unknown;
		enumValues?: string[];
	}>;
	examples?: Array<{ description: string; params: Record<string, unknown> }>;
	/** 五行分类，默认使用插件自身的 element */
	category?: "metal" | "wood" | "water" | "fire" | "earth";
}

export interface PluginAPI {
	/** 注册额外工具（可附带定义，使 AI 模型能感知此工具） */
	registerTool?: (
		name: string,
		handler: (args: any) => Promise<any>,
		def?: ToolRegistration,
	) => void;
	/** HTTP 请求辅助 */
	fetch?: (url: string, options?: RequestInit) => Promise<Response>;
}

export interface Plugin {
	manifest: PluginManifest;
	/** 插件初始化 */
	init: (ctx: PluginContext, api: PluginAPI) => Promise<void>;
	/** 插件卸载 */
	destroy?: () => Promise<void>;
	/** 插件卸载生命周期回调（与 PluginContext.onUnload 注册的 disposer 互补） */
	onUnload?: (data: { pluginName: string }) => Promise<void>;

	// 事件处理器
	onToolCall?: (toolCall: {
		type: string;
		args: Record<string, unknown>;
	}) => Promise<void>;
	onToolResult?: (result: {
		success: boolean;
		data?: string;
		error?: string;
	}) => Promise<void>;
	onSessionStart?: () => Promise<void>;
	onSessionEnd?: (summary: {
		turnCount: number;
		duration: number;
	}) => Promise<void>;
	onError?: (error: Error) => Promise<void>;
}

// ===== 插件注册表 =====

type ToolHandler = (args: any) => Promise<any>;

export class PluginRegistry {
	private plugins: Map<string, Plugin> = new Map();
	private extraTools: Map<string, ToolHandler> = new Map();
	private extraToolDefs: Map<string, ToolRegistration> = new Map();
	private contexts: Map<string, PluginContext> = new Map();
	private eventBus: Map<PluginEvent, Set<string>> = new Map();
	private disposers: Map<string, Set<() => void>> = new Map();

	constructor() {
		for (const event of [
			"onLoad",
			"onUnload",
			"onToolCall",
			"onToolResult",
			"onSessionStart",
			"onSessionEnd",
			"onError",
		] as PluginEvent[]) {
			this.eventBus.set(event, new Set());
		}
	}

	/** 注册一个插件 */
	async register(plugin: Plugin, ctx?: Partial<PluginContext>): Promise<void> {
		const name = plugin.manifest.name;
		if (this.plugins.has(name)) {
			throw new Error(`插件 "${name}" 已注册`);
		}

		const fullCtx: PluginContext = {
			workDir: ctx?.workDir || process.cwd(),
			sessionId: ctx?.sessionId,
			config: ctx?.config || {},
			log: (msg: string) => console.error(`[${name}] ${msg}`),
		};

		const api: PluginAPI = {
			registerTool: (toolName, handler, def) => {
				this.extraTools.set(`${name}:${toolName}`, handler);
				if (def) {
					this.extraToolDefs.set(`${name}:${toolName}`, def);
				}
			},
			fetch: (url, options) => fetch(url, options),
		};

		this.disposers.set(name, new Set());
		fullCtx.onUnload = (cb) => this.disposers.get(name)?.add(cb);

		await plugin.init(fullCtx, api);

		this.plugins.set(name, plugin);
		this.contexts.set(name, fullCtx);

		// 注册事件订阅
		for (const event of plugin.manifest.events) {
			this.eventBus.get(event)?.add(name);
		}
	}

	/** 卸载一个插件 */
	async unregister(name: string): Promise<void> {
		const plugin = this.plugins.get(name);
		if (!plugin) return;

		// 执行插件注册的副作用清理（逆序）
		const cleanups = this.disposers.get(name);
		if (cleanups) {
			for (const cb of Array.from(cleanups).reverse()) {
				try {
					cb();
				} catch (err) {
					console.error(`[插件] ${name} 清理副作用失败:`, err);
				}
			}
			this.disposers.delete(name);
		}

		if (plugin.destroy) {
			await plugin.destroy();
		}

		// 触发 onUnload 生命周期事件（在移除订阅前 emit，保证 handler 可被调用）
		await this.emitEvent("onUnload", { pluginName: name });

		// 移除工具
		for (const key of this.extraTools.keys()) {
			if (key.startsWith(`${name}:`)) {
				this.extraTools.delete(key);
			}
		}

		// 取消事件订阅
		for (const [, subscribers] of this.eventBus) {
			subscribers.delete(name);
		}

		this.plugins.delete(name);
		this.contexts.delete(name);
	}

	/** 获取已注册的插件列表 */
	listPlugins(): PluginManifest[] {
		return Array.from(this.plugins.values()).map((p) => p.manifest);
	}

	/** 按五行分类列出插件 */
	listByElement(): Record<ElementType, PluginManifest[]> {
		const result: Record<ElementType, PluginManifest[]> = {
			metal: [],
			wood: [],
			water: [],
			fire: [],
			earth: [],
		};
		for (const plugin of this.plugins.values()) {
			result[plugin.manifest.element].push(plugin.manifest);
		}
		return result;
	}

	/** 获取注册的外部工具 */
	getExtraTools(): Map<string, ToolHandler> {
		return this.extraTools;
	}

	/** 获取去掉命名空间前缀的 tool overrides（"pluginName:toolName" → "toolName"） */
	getToolOverrides(): Map<string, ToolHandler> {
		const overrides = new Map<string, ToolHandler>();
		for (const [key, handler] of this.extraTools) {
			const colonIdx = key.indexOf(":");
			const toolName = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;
			overrides.set(toolName, handler);
		}
		return overrides;
	}

	/** 触发事件 */
	async emitEvent(event: PluginEvent, ...args: any[]): Promise<void> {
		const subscribers = this.eventBus.get(event);
		if (!subscribers) return;

		for (const name of subscribers) {
			const plugin = this.plugins.get(name);
			if (!plugin) continue;

			try {
				const handler = (plugin as any)[event];
				if (handler) {
					await handler(...args);
				}
			} catch (err) {
				console.error(`[插件] ${name} 处理事件 ${event} 失败:`, err);
			}
		}
	}

	/** 获取工具定义列表（含 handler），用于注册到 ToolManager 的 extraDefinitions */
	getToolDefinitions(): Array<{ def: ToolDefinition; handler: ToolHandler }> {
		const result: Array<{ def: ToolDefinition; handler: ToolHandler }> = [];
		for (const [key, reg] of this.extraToolDefs) {
			const colonIdx = key.indexOf(":");
			const toolName = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;
			const handler = this.extraTools.get(key);
			if (!handler) continue;
			result.push({
				def: {
					type: toolName,
					name: toolName,
					description: reg.description,
					parameters: reg.parameters,
					examples: reg.examples || [],
					alwaysLoad: false,
					category: reg.category || "earth",
				},
				handler,
			});
		}
		return result;
	}

	/** 获取插件数 */
	get count(): number {
		return this.plugins.size;
	}

	/** 清除所有已注册的插件（注意：不调用 destroy，如需清理副作用请用 unregister） */
	clear(): void {
		this.plugins.clear();
		this.extraTools.clear();
		this.extraToolDefs.clear();
		this.contexts.clear();
		this.disposers.clear();
		for (const [, subscribers] of this.eventBus) {
			subscribers.clear();
		}
	}
}

// ===== 插件发现 =====

export { PluginDiscovery } from "./discovery";
export type {
	DiscoveredPlugin,
	PluginDiscoveryOptions,
	XuanCodePluginConfig,
} from "./discovery";

// ===== 配置加载 =====

export { PluginConfigLoader } from "./config";
export type { PluginConfigItem, XuanCodeConfig } from "./config";

// ===== Hook 桥接 =====

export { createHookBridge, getHookEventMappings } from "./hookBridge";

// ===== 插件管理器 =====

export { PluginManager } from "./pluginManager";
export type { PluginManagerOptions } from "./pluginManager";

// ===== 辅助工厂 =====

export function createPlugin(
	manifest: PluginManifest,
	init: (ctx: PluginContext, api: PluginAPI) => Promise<void>,
	handlers?: Partial<
		Pick<
			Plugin,
			| "destroy"
			| "onUnload"
			| "onToolCall"
			| "onToolResult"
			| "onSessionStart"
			| "onSessionEnd"
			| "onError"
		>
	>,
): Plugin {
	return { manifest, init, ...handlers };
}
