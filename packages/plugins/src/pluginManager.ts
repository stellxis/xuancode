/**
 * 玄码 PluginManager — 编排插件发现、注册、配置、Hook 桥接
 *
 * 将 PluginDiscovery、PluginConfigLoader、PluginRegistry、HookBridge
 * 整合为单一入口，供 daemon 生产入口使用。
 */

import { createRequire } from "node:module";
import { PluginConfigLoader, type XuanCodeConfig } from "./config";
import {
	type DiscoveredPlugin,
	PluginDiscovery,
	type XuanCodePluginConfig,
} from "./discovery";
import { createHookBridge } from "./hookBridge";
import { type Plugin, PluginRegistry } from "./index";

const _require = createRequire(import.meta.url);

/** 插件生命周期事件（由宿主记录到事件流） */
export type PluginLifecycleEvent =
	| { type: "plugin_loaded"; name: string; version?: string }
	| { type: "plugin_unloaded"; name: string }
	| { type: "plugin_load_failed"; name: string; error: string }
	| { type: "plugin_destroy_error"; name: string; error: string };

export interface PluginManagerOptions {
	/** 项目根目录 */
	projectDir?: string;
	/** 是否自动发现 npm 插件包 */
	autoDiscover?: boolean;
	/** 插件生命周期事件回调，宿主可写入追加式事件流 */
	onEvent?: (event: PluginLifecycleEvent) => void;
}

export class PluginManager {
	readonly registry: PluginRegistry;
	readonly discovery: PluginDiscovery;
	readonly configLoader: PluginConfigLoader;
	readonly options: PluginManagerOptions;

	private initialized = false;

	constructor(options: PluginManagerOptions = {}) {
		this.options = options;
		this.registry = new PluginRegistry();
		this.discovery = new PluginDiscovery({
			projectDir: options.projectDir,
		});
		this.configLoader = new PluginConfigLoader(options.projectDir);
	}

	/** 初始化: 发现并加载所有插件 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		const config = this.configLoader.load();
		const discovered = await this.discovery.discoverAll(
			config as XuanCodePluginConfig | undefined,
		);

		let loaded = 0;

		for (const plugin of discovered) {
			if (!plugin.enabled) continue;
			try {
				const loadedPlugin = await this.loadPlugin(plugin, config);
				if (loadedPlugin) {
					loaded++;
					this.emit({
						type: "plugin_loaded",
						name: loadedPlugin.manifest.name,
						version: loadedPlugin.manifest.version,
					});
				}
			} catch (err) {
				this.emit({
					type: "plugin_load_failed",
					name: plugin.name,
					error: String(err),
				});
				console.error(`[PluginManager] 加载插件 "${plugin.name}" 失败:`, err);
			}
		}

		this.initialized = true;
	}

	/** 强制重新初始化（安装/卸载后调用）— 先卸载全部以触发副作用清理，再重新加载 */
	async reinitialize(): Promise<void> {
		this.initialized = false;
		for (const manifest of this.registry.listPlugins()) {
			try {
				await this.registry.unregister(manifest.name);
				this.emit({ type: "plugin_unloaded", name: manifest.name });
			} catch (err) {
				this.emit({
					type: "plugin_destroy_error",
					name: manifest.name,
					error: String(err),
				});
				console.error(`[PluginManager] 卸载插件 "${manifest.name}" 失败:`, err);
			}
		}
		await this.initialize();
	}

	/** 获取 HookBridge 的 onHook 回调（传入 runTaorLoop options） */
	getHookCallback(): (event: string, context: Record<string, unknown>) => void {
		return createHookBridge(this.registry);
	}

	/** 获取插件加载统计 */
	getStats(): {
		total: number;
		loaded: number;
		byElement: Record<string, number>;
	} {
		const plugins = this.registry.listPlugins();
		const byElement: Record<string, number> = {};

		for (const p of plugins) {
			byElement[p.element] = (byElement[p.element] || 0) + 1;
		}

		return {
			total: plugins.length,
			loaded: plugins.length,
			byElement,
		};
	}

	// ===== 私有方法 =====

	private async loadPlugin(
		discovered: DiscoveredPlugin,
		config?: XuanCodeConfig | null,
	): Promise<Plugin | undefined> {
		// 动态导入插件入口
		let mod: any;
		try {
			mod = await import(/* @vite-ignore */ discovered.entry);
		} catch (err) {
			// 尝试相对路径解析
			const projectDir = this.options.projectDir || process.cwd();
			const resolved = _require.resolve(discovered.entry, {
				paths: [projectDir],
			});
			mod = await import(/* @vite-ignore */ resolved);
		}

		// 支持: export default plugin | export function createPlugin | export plugin
		let plugin: Plugin | undefined;

		if (
			mod.default &&
			typeof mod.default === "object" &&
			mod.default.manifest
		) {
			plugin = mod.default;
		} else if (mod.createPlugin && typeof mod.createPlugin === "function") {
			plugin = mod.createPlugin();
		} else if (mod.plugin?.manifest) {
			plugin = mod.plugin;
		}

		if (!plugin) {
			throw new Error(
				`插件 "${discovered.name}" 没有有效的导出 (需要 default export 或 createPlugin())`,
			);
		}

		// 获取配置项中的自定义配置
		const pluginConfig = config?.plugins?.find(
			(p) => p.name === discovered.name,
		)?.config;

		await this.registry.register(plugin, {
			workDir: this.options.projectDir || process.cwd(),
			config: pluginConfig || {},
		});

		return plugin;
	}

	private emit(event: PluginLifecycleEvent): void {
		try {
			this.options.onEvent?.(event);
		} catch (err) {
			console.error("[PluginManager] 事件回调执行失败:", err);
		}
	}
}
