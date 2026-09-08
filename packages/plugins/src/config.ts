/**
 * 玄码插件配置加载器
 *
 * 从 .xuancode/xuancode.json 加载插件配置，含 schema 验证。
 */

import fs from "node:fs";
import path from "node:path";
import { resolveProjectData } from "@xuancode/utils";

// ===== 配置 schema 类型 =====

export interface PluginConfigItem {
	name: string;
	entry?: string;
	path?: string;
	element?: "metal" | "wood" | "water" | "fire" | "earth";
	enabled: boolean;
	config?: Record<string, unknown>;
}

export interface XuanCodeConfig {
	plugins?: PluginConfigItem[];
	/** 全局插件设置 */
	pluginSettings?: {
		/** 是否允许自动发现 npm 插件包 */
		autoDiscover?: boolean;
		/** 插件目录额外扫描路径 */
		scanDirs?: string[];
	};
}

// ===== 配置加载器 =====

export class PluginConfigLoader {
	private configDir: string;

	constructor(projectDir?: string) {
		this.configDir = resolveProjectData(
			path.resolve(projectDir || process.cwd()),
		);
	}

	/** 加载配置 */
	load(): XuanCodeConfig | null {
		const configPath = path.join(this.configDir, "xuancode.json");
		if (!fs.existsSync(configPath)) return null;

		try {
			const raw = fs.readFileSync(configPath, "utf-8");
			const parsed = JSON.parse(raw);
			return this.validate(parsed);
		} catch (err) {
			console.error(`[插件配置] 加载失败 (${configPath}):`, err);
			return null;
		}
	}

	/** 写入配置 */
	save(config: XuanCodeConfig): void {
		if (!fs.existsSync(this.configDir)) {
			fs.mkdirSync(this.configDir, { recursive: true });
		}
		const configPath = path.join(this.configDir, "xuancode.json");
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
	}

	/** 启用一个插件 */
	enablePlugin(name: string, element?: string): boolean {
		const config = this.load() || { plugins: [] };
		const existing = config.plugins?.find((p) => p.name === name);
		if (existing) {
			existing.enabled = true;
			if (element) (existing as any).element = element;
		} else {
			config.plugins = config.plugins || [];
			config.plugins.push({
				name,
				element: element as any,
				enabled: true,
			});
		}
		this.save(config);
		return true;
	}

	/** 禁用一个插件 */
	disablePlugin(name: string): boolean {
		const config = this.load();
		if (!config?.plugins) return false;
		const plugin = config.plugins.find((p) => p.name === name);
		if (plugin) {
			plugin.enabled = false;
			this.save(config);
			return true;
		}
		return false;
	}

	/** 获取插件配置项 */
	getPluginConfig(name: string): Record<string, unknown> | undefined {
		const config = this.load();
		return config?.plugins?.find((p) => p.name === name)?.config;
	}

	// ===== 验证 =====

	private validate(raw: any): XuanCodeConfig {
		const config: XuanCodeConfig = {};

		if (raw.plugins && Array.isArray(raw.plugins)) {
			config.plugins = raw.plugins.map((item: any) =>
				this.validatePluginItem(item),
			);
		}

		if (raw.pluginSettings && typeof raw.pluginSettings === "object") {
			config.pluginSettings = {
				autoDiscover: raw.pluginSettings.autoDiscover !== false,
				scanDirs: Array.isArray(raw.pluginSettings.scanDirs)
					? raw.pluginSettings.scanDirs.map(String)
					: undefined,
			};
		}

		return config;
	}

	private validatePluginItem(item: any): PluginConfigItem {
		const validElements = ["metal", "wood", "water", "fire", "earth"];

		return {
			name: String(item.name || "unnamed-plugin"),
			entry: item.entry ? String(item.entry) : undefined,
			path: item.path ? String(item.path) : undefined,
			element: validElements.includes(item.element) ? item.element : undefined,
			enabled: item.enabled !== false,
			config:
				item.config && typeof item.config === "object"
					? { ...item.config }
					: undefined,
		};
	}
}
