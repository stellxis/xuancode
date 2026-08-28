/**
 * 玄码插件发现系统 — 三层插件发现
 *
 * 1. 本地目录: ~/.xuancode/plugins/ + <project>/.xuancode/plugins/
 * 2. 配置文件: .xuancode/xuancode.json 中 plugins[] 数组
 * 3. NPM 包: @xuancode/plugin-* 或有 "xuancode-plugin": true 标志
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ===== 类型定义 =====

export interface DiscoveredPlugin {
	/** 插件唯一名称 */
	name: string;
	/** 来源: "local" | "config" | "npm" */
	source: "local" | "config" | "npm";
	/** 插件入口文件路径或模块名 */
	entry: string;
	/** 五行分类（可选，从文件名/配置推断） */
	element?: string;
	/** 是否启用 */
	enabled: boolean;
}

export interface PluginDiscoveryOptions {
	/** 项目根目录（用于扫描 .xuancode/plugins/） */
	projectDir?: string;
	/** 自定义扫描目录 */
	extraScanDirs?: string[];
}

// ===== 发现器 =====

export class PluginDiscovery {
	constructor(private options: PluginDiscoveryOptions = {}) {}

	/** 第一层: 扫描本地目录 */
	async scanDirectories(): Promise<DiscoveredPlugin[]> {
		const result: DiscoveredPlugin[] = [];
		const scanned = new Set<string>();

		const dirs = [
			path.join(osHomeDir(), ".xuancode", "plugins"),
			...(this.options.projectDir
				? [path.join(this.options.projectDir, ".xuancode", "plugins")]
				: []),
			...(this.options.extraScanDirs || []),
		];

		for (const dir of dirs) {
			if (!fs.existsSync(dir)) continue;

			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (
					entry.isFile() &&
					(entry.name.endsWith(".js") ||
						entry.name.endsWith(".mjs") ||
						entry.name.endsWith(".ts"))
				) {
					const name = entry.name.replace(/\.(js|mjs|ts)$/, "");
					if (scanned.has(name)) continue;
					scanned.add(name);

					const fullPath = path.resolve(dir, entry.name);
					result.push({
						name,
						source: "local",
						entry: fullPath,
						enabled: true,
					});
				}
			}
		}

		return result;
	}

	/** 第二层: 从配置文件加载 */
	async loadConfig(config: XuanCodePluginConfig): Promise<DiscoveredPlugin[]> {
		const result: DiscoveredPlugin[] = [];

		for (const item of config.plugins || []) {
			if (typeof item === "string") {
				result.push({
					name: path.basename(item).replace(/\.(js|mjs|ts)$/, ""),
					source: "config",
					entry: item,
					enabled: true,
				});
			} else {
				result.push({
					name:
						item.name ||
						path
							.basename(item.entry || item.path || "")
							.replace(/\.(js|mjs|ts)$/, ""),
					source: "config",
					entry: item.entry || item.path || item.name || "",
					element: item.element,
					enabled: item.enabled !== false,
				});
			}
		}

		return result;
	}

	/** 第三层: 解析 NPM 包 */
	async resolveNPMPackages(
		packageNames: string[],
	): Promise<DiscoveredPlugin[]> {
		const result: DiscoveredPlugin[] = [];

		for (const pkgName of packageNames) {
			try {
				const entry = this.resolveNPMPackageEntry(pkgName);
				if (entry) {
					result.push({
						name: pkgName,
						source: "npm",
						entry,
						enabled: true,
					});
				}
			} catch {
				// 包未安装，跳过
			}
		}

		return result;
	}

	/** 自动发现所有已安装的 @xuancode/plugin-* 包 */
	async autoDetectNPMPackages(): Promise<DiscoveredPlugin[]> {
		const result: DiscoveredPlugin[] = [];
		const projectDir = this.options.projectDir || process.cwd();

		// 检查 node_modules 中 @xuancode 作用域下的插件包
		const scopeDir = path.join(projectDir, "node_modules", "@xuancode");
		if (fs.existsSync(scopeDir)) {
			const dirs = fs.readdirSync(scopeDir, { withFileTypes: true });
			for (const dir of dirs) {
				if (dir.isDirectory() && dir.name.startsWith("plugin-")) {
					const pkgJsonPath = path.join(scopeDir, dir.name, "package.json");
					if (fs.existsSync(pkgJsonPath)) {
						try {
							const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
							if (pkg.xuancodePlugin !== false) {
								result.push({
									name: `@xuancode/${dir.name}`,
									source: "npm",
									entry: `@xuancode/${dir.name}`,
									enabled: true,
								});
							}
						} catch {
							/* 忽略解析错误 */
						}
					}
				}
			}
		}

		// 检查所有 node_modules 中标记了 xuancode-plugin 的包
		const allPkgs = this.findXuancodePluginPackages(projectDir);
		for (const pkg of allPkgs) {
			if (!result.find((r) => r.name === pkg.name)) {
				result.push({
					name: pkg.name,
					source: "npm",
					entry: pkg.name,
					enabled: true,
				});
			}
		}

		return result;
	}

	/** 全量发现: 三层叠加 */
	async discoverAll(
		config?: XuanCodePluginConfig,
	): Promise<DiscoveredPlugin[]> {
		const all = new Map<string, DiscoveredPlugin>();

		// 第一层: 本地目录
		for (const p of await this.scanDirectories()) {
			all.set(p.name, p);
		}

		// 第二层: NPM 自动检测
		for (const p of await this.autoDetectNPMPackages()) {
			if (!all.has(p.name)) all.set(p.name, p);
		}

		// 第三层: 配置文件（优先级最高，覆盖同名插件）
		if (config) {
			for (const p of await this.loadConfig(config)) {
				all.set(p.name, p);
			}
		}

		return Array.from(all.values());
	}

	// ===== 私有方法 =====

	private resolveNPMPackageEntry(pkgName: string): string | null {
		try {
			const resolved = require.resolve(pkgName, {
				paths: [this.options.projectDir || process.cwd()],
			});
			return resolved;
		} catch {
			return null;
		}
	}

	private findXuancodePluginPackages(
		projectDir: string,
	): Array<{ name: string }> {
		const result: Array<{ name: string }> = [];
		const modulesDir = path.join(projectDir, "node_modules");

		if (!fs.existsSync(modulesDir)) return result;

		try {
			const dirs = fs.readdirSync(modulesDir, { withFileTypes: true });
			for (const dir of dirs) {
				if (
					!dir.isDirectory() ||
					dir.name.startsWith(".") ||
					dir.name.startsWith("@")
				)
					continue;
				const pkgJsonPath = path.join(modulesDir, dir.name, "package.json");
				if (fs.existsSync(pkgJsonPath)) {
					try {
						const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
						if (pkg.xuancodePlugin) {
							result.push({ name: dir.name });
						}
					} catch {
						/* 忽略 */
					}
				}
			}
		} catch {
			/* 忽略 */
		}

		return result;
	}
}

// ===== 配置文件类型 =====

export interface XuanCodePluginConfig {
	plugins: Array<
		| string
		| {
				name?: string;
				entry?: string;
				path?: string;
				element?: string;
				enabled?: boolean;
				config?: Record<string, unknown>;
		  }
	>;
}

// ===== 工具函数 =====

function osHomeDir(): string {
	return process.env.HOME || process.env.USERPROFILE || "/home/user";
}
