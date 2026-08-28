import path from "node:path";
import { type PermissionDecision, checkPermission } from "@xuancode/permission";
import {
	type AgentMode,
	type ToolCallParams,
	type ToolDefinition,
	type ToolExample,
	type ToolParameter,
	type ToolResult,
	ToolType,
} from "@xuancode/types";
import { listDir } from "./dirTool";
import { editFile } from "./editTool";
import { readFile, readFiles, writeFile } from "./fileTool";
import {
	gitBranch,
	gitCommit,
	gitDiff,
	gitLog,
	gitPush,
	gitStatus,
} from "./gitTool";
import { globFiles } from "./globTool";
import { grepFiles } from "./grepTool";
import { initIgnore } from "./ignore";
import type { MCPClient, MCPToolDefinition } from "./mcpClient";
import { runShell } from "./shellTool";
import { webFetch, webSearch } from "./webTool";

type ToolHandler = (params: ToolCallParams) => Promise<ToolResult>;

/** Callback for user-in-the-loop permission confirmation.
 *  Called when a tool requires user confirmation based on the current mode.
 *  Return true to allow, false to deny. */
export type PermissionConfirmCallback = (
	toolType: string,
	params: ToolCallParams,
	decision: PermissionDecision,
) => Promise<boolean>;

export class ToolManager {
	private cwd: string;
	private mode: AgentMode = "default";
	private handlers: Map<string, ToolHandler> = new Map();
	private definitions: Map<string, ToolDefinition> = new Map();
	public onPermissionConfirm?: PermissionConfirmCallback;

	constructor(workDir: string, mode?: AgentMode) {
		this.cwd = workDir;
		if (mode) this.mode = mode;
		initIgnore(workDir);
		this.registerDefaults();
	}

	/** Whether tools should enforce the workdir boundary */
	private get strictBoundary(): boolean {
		return this.mode !== "bypass";
	}

	/** Update trust mode (called by TAOR loop on mode change) */
	setMode(mode: AgentMode): void {
		this.mode = mode;
	}

	// ===== 注册 =====

	private registerDefaults() {
		this.define(
			{
				type: ToolType.READ_FILE,
				name: "read_file",
				description:
					"读取文件内容。用于查看源代码、配置文件、日志等文本文件。大文件请配合 start_line/end_line 分块读取（每块 100~200 行），不要用 sed/head/tail/wc 命令。",
				parameters: [
					{
						name: "path",
						type: "string",
						description: "文件路径（使用相对路径，相对于项目根目录）",
						required: true,
					},
					{
						name: "start_line",
						type: "number",
						description: "起始行号（1 起），与 end_line 配合分块读取大文件",
						required: false,
					},
					{
						name: "end_line",
						type: "number",
						description: "结束行号（含该行），与 start_line 配合分块读取大文件",
						required: false,
					},
				],
				examples: [
					{ description: "读取配置文件", params: { path: "package.json" } },
					{ description: "读取源码", params: { path: "src/index.ts" } },
					{
						description: "分块读取大文件第 1-200 行",
						params: { path: "src/App.tsx", start_line: 1, end_line: 200 },
					},
				],
				alwaysLoad: true,
				category: "metal",
			},
			(p) =>
				readFile(this.cwd, p.path!, {
					strictBoundary: this.strictBoundary,
					startLine:
						p.start_line !== undefined ? Number(p.start_line) : undefined,
					endLine: p.end_line !== undefined ? Number(p.end_line) : undefined,
				}),
		);

		this.define(
			{
				type: "read_files",
				name: "read_files",
				description:
					"批量读取多个文件的内容。一次性读取多个文件，比多次调用 read_file 更高效。适合需要同时查看多个源文件、配置文件的场景。",
				parameters: [
					{
						name: "paths",
						type: "array",
						description: "文件路径列表（使用相对路径，相对于项目根目录）",
						required: true,
					},
				],
				examples: [
					{
						description: "同时读取多个配置文件",
						params: {
							paths: ["package.json", "tsconfig.json", "vite.config.ts"],
						},
					},
					{
						description: "同时读取多个源文件",
						params: { paths: ["src/index.ts", "src/utils.ts"] },
					},
				],
				alwaysLoad: true,
				category: "metal",
			},
			(p) =>
				readFiles(this.cwd, p.paths!, { strictBoundary: this.strictBoundary }),
		);

		this.define(
			{
				type: ToolType.WRITE_FILE,
				name: "write_file",
				description:
					"写入文件内容。会覆盖已存在的文件。适合新建文件或整体重写。如需局部修改请用 edit_file。",
				parameters: [
					{
						name: "path",
						type: "string",
						description: "文件路径（使用相对路径，相对于项目根目录）",
						required: true,
					},
					{
						name: "content",
						type: "string",
						description: "文件内容",
						required: true,
					},
				],
				examples: [
					{
						description: "创建新文件",
						params: {
							path: "src/hello.ts",
							content:
								"export const greet = (name: string) => `Hello ${name}`;",
						},
					},
				],
				alwaysLoad: true,
				category: "metal",
			},
			(p) =>
				writeFile(this.cwd, p.path!, p.content!, {
					strictBoundary: this.strictBoundary,
				}),
		);

		this.define(
			{
				type: ToolType.EDIT_FILE,
				name: "edit_file",
				description:
					"精准替换文件中的文本。适合局部修改，比 write_file 全量重写更安全高效。old_string 必须与文件中内容完全一致（包括空格和换行）。",
				parameters: [
					{
						name: "path",
						type: "string",
						description: "文件路径（使用相对路径，相对于项目根目录）",
						required: true,
					},
					{
						name: "old_string",
						type: "string",
						description: "被替换的原文（必须精确匹配）",
						required: true,
					},
					{
						name: "new_string",
						type: "string",
						description: "替换后的新文本",
						required: true,
					},
				],
				examples: [
					{
						description: "修改变量名",
						params: {
							path: "src/index.ts",
							old_string: "oldName",
							new_string: "newName",
						},
					},
				],
				alwaysLoad: true,
				category: "metal",
			},
			(p) => editFile(this.cwd, p.path!, p.old_string!, p.new_string!),
		);

		this.define(
			{
				type: ToolType.LIST_DIR,
				name: "list_dir",
				description:
					"列出目录内容。查看项目结构时使用，会返回文件和子目录列表（自动排除 .gitignore 匹配项）。",
				parameters: [
					{
						name: "path",
						type: "string",
						description: "目录路径，默认为项目根目录",
						required: false,
						default: ".",
					},
				],
				examples: [
					{ description: "查看根目录", params: { path: "." } },
					{ description: "查看 src 目录", params: { path: "src" } },
				],
				alwaysLoad: true,
				category: "metal",
			},
			(p) => listDir(this.cwd, p.path || "."),
		);

		this.define(
			{
				type: ToolType.SHELL,
				name: "shell",
				description:
					"执行 Shell 命令。用于运行测试、构建、安装依赖、git 操作等。命令在工作目录下执行。",
				parameters: [
					{
						name: "command",
						type: "string",
						description: "要执行的 shell 命令",
						required: true,
					},
				],
				examples: [
					{ description: "运行测试", params: { command: "npm test" } },
					{ description: "安装依赖", params: { command: "pnpm install" } },
				],
				alwaysLoad: true,
				category: "fire",
			},
			(p) => runShell(this.cwd, p.command!),
		);

		this.define(
			{
				type: ToolType.GLOB,
				name: "glob",
				description:
					"按模式匹配查找文件。支持 **/* 递归匹配，自动排除 .gitignore。用于查找特定类型的文件。",
				parameters: [
					{
						name: "pattern",
						type: "string",
						description: "glob 模式，如 **/*.ts 或 src/**/*.test.ts",
						required: true,
					},
					{
						name: "path",
						type: "string",
						description: "搜索起始目录",
						required: false,
						default: ".",
					},
				],
				examples: [
					{
						description: "查找所有 TypeScript 文件",
						params: { pattern: "**/*.ts" },
					},
					{ description: "查找测试文件", params: { pattern: "**/*.test.ts" } },
				],
				alwaysLoad: true,
				category: "wood",
			},
			(p) => globFiles(path.join(this.cwd, p.path || "."), p.pattern!),
		);

		this.define(
			{
				type: ToolType.GREP,
				name: "grep",
				description:
					"在文件中搜索文本模式。支持正则表达式，自动排除 .gitignore。用于查找函数定义、引用、TODO 等。",
				parameters: [
					{
						name: "pattern",
						type: "string",
						description: "搜索模式（正则表达式）",
						required: true,
					},
					{
						name: "path",
						type: "string",
						description: "文件路径或 glob 模式，如 *.ts",
						required: false,
					},
				],
				examples: [
					{
						description: "搜索函数定义",
						params: { pattern: "export function" },
					},
					{
						description: "在特定文件中搜索",
						params: { pattern: "TODO", path: "*.ts" },
					},
				],
				alwaysLoad: true,
				category: "wood",
			},
			(p) => grepFiles(this.cwd, p.pattern!, p.path),
		);

		this.define(
			{
				type: ToolType.WEB_SEARCH,
				name: "web_search",
				description:
					"通过网络搜索引擎查询信息。当需要最新资讯、文档、API 用法、bug 解决方案时使用。需要配置 SERPAPI_API_KEY。",
				parameters: [
					{
						name: "query",
						type: "string",
						description: "搜索关键词",
						required: true,
					},
				],
				examples: [
					{
						description: "搜索最新文档",
						params: { query: "vitest latest documentation" },
					},
				],
				alwaysLoad: false,
				category: "water",
			},
			(p) => webSearch(p.query!),
		);

		this.define(
			{
				type: ToolType.WEB_FETCH,
				name: "web_fetch",
				description:
					"获取指定 URL 的内容并转为纯文本。用于阅读在线文档、博客、API 响应等。",
				parameters: [
					{
						name: "url",
						type: "string",
						description: "要获取的完整 URL（含 https://）",
						required: true,
					},
				],
				examples: [
					{
						description: "读取文档页面",
						params: { url: "https://example.com/docs" },
					},
				],
				alwaysLoad: false,
				category: "water",
			},
			(p) => webFetch(p.url!),
		);

		// ===== Git 工具集 =====

		this.define(
			{
				type: "git_status",
				name: "git_status",
				description:
					"查看 Git 仓库状态，包括当前分支、未暂存/已暂存的变更、新增/删除文件等。开始编码任务前先调用此工具了解项目状态。",
				parameters: [],
				examples: [{ description: "查看当前仓库状态", params: {} }],
				alwaysLoad: false,
				category: "fire",
			},
			(p) => gitStatus(this.cwd),
		);

		this.define(
			{
				type: "git_diff",
				name: "git_diff",
				description:
					"查看文件的详细差异（diff）。支持查看工作区和暂存区的变更。",
				parameters: [
					{
						name: "path",
						type: "string",
						description: "指定文件或目录路径，只查看特定文件的变更",
						required: false,
					},
					{
						name: "staged",
						type: "boolean",
						description: "设为 true 查看已暂存（staged）的变更",
						required: false,
					},
				],
				examples: [
					{ description: "查看所有未暂存的变更", params: {} },
					{
						description: "查看特定文件的变更",
						params: { path: "src/index.ts" },
					},
				],
				alwaysLoad: false,
				category: "fire",
			},
			(p) => gitDiff(this.cwd, { path: p.path, staged: p.staged as boolean }),
		);

		this.define(
			{
				type: "git_log",
				name: "git_log",
				description:
					"查看 Git 提交历史。默认显示最近 20 条提交，包括哈希、作者、日期和提交信息。",
				parameters: [
					{
						name: "count",
						type: "number",
						description: "显示最近 N 条提交，默认 20",
						required: false,
					},
				],
				examples: [
					{ description: "查看最近提交", params: {} },
					{ description: "查看最近 5 条", params: { count: 5 } },
				],
				alwaysLoad: false,
				category: "fire",
			},
			(p) => gitLog(this.cwd, { count: (p.count as number) || undefined }),
		);

		this.define(
			{
				type: "git_branch",
				name: "git_branch",
				description: "管理 Git 分支。支持列出所有分支、创建新分支、删除分支。",
				parameters: [
					{
						name: "action",
						type: "string",
						description:
							"操作类型：list（列出）、create（创建）、delete（删除）",
						required: false,
						default: "list",
						enumValues: ["list", "create", "delete"],
					},
					{
						name: "name",
						type: "string",
						description: "分支名称（create/delete 时需要）",
						required: false,
					},
				],
				examples: [
					{ description: "列出所有分支", params: { action: "list" } },
					{
						description: "创建新分支",
						params: { action: "create", name: "feature/new-feature" },
					},
				],
				alwaysLoad: false,
				category: "fire",
			},
			(p) => gitBranch(this.cwd, { action: p.action as any, name: p.name }),
		);

		this.define(
			{
				type: "git_commit",
				name: "git_commit",
				description:
					"创建 Git 提交。支持自动暂存所有更改（addAll=true）后再提交。提交信息不能为空。",
				parameters: [
					{
						name: "message",
						type: "string",
						description: "提交信息，描述本次变更内容",
						required: true,
					},
					{
						name: "add_all",
						type: "boolean",
						description: "设为 true 会自动执行 git add -A 再提交",
						required: false,
					},
				],
				examples: [
					{
						description: "提交已暂存的变更",
						params: { message: "fix: 修复登录页面样式" },
					},
					{
						description: "自动暂存并提交",
						params: { message: "feat: 添加用户头像功能", add_all: true },
					},
				],
				alwaysLoad: false,
				category: "fire",
			},
			(p) => gitCommit(this.cwd, p.message!, { addAll: p.add_all as boolean }),
		);

		this.define(
			{
				type: "git_push",
				name: "git_push",
				description:
					"将本地提交推送到远程仓库。默认推送到 origin 当前分支。注意：推送操作会真实修改远程仓库。",
				parameters: [
					{
						name: "remote",
						type: "string",
						description: "远程仓库名称，默认 origin",
						required: false,
					},
					{
						name: "branch",
						type: "string",
						description: "分支名称，默认当前分支",
						required: false,
					},
				],
				examples: [
					{ description: "推送到远程", params: {} },
					{
						description: "推送到指定远程和分支",
						params: { remote: "upstream", branch: "main" },
					},
				],
				alwaysLoad: false,
				category: "fire",
			},
			(p) => gitPush(this.cwd, { remote: p.remote, branch: p.branch }),
		);
	}

	/** 注册带元数据的工具 */
	define(def: ToolDefinition, handler: ToolHandler): void {
		this.definitions.set(def.type, def);
		this.handlers.set(def.type, handler);
	}

	/** 注册外部工具（插件系统用） */
	registerTool(
		type: string,
		handler: ToolHandler,
		def?: Partial<ToolDefinition>,
	): void {
		this.handlers.set(type, handler);
		if (def) {
			this.definitions.set(type, {
				type,
				name: def.name || type,
				description: def.description || "",
				parameters: def.parameters || [],
				examples: def.examples || [],
				alwaysLoad: def.alwaysLoad || false,
				category: def.category || "earth",
			});
		}
	}

	// ===== 执行 =====

	async dispatch(params: ToolCallParams): Promise<ToolResult> {
		const handler = this.handlers.get(params.type);
		if (!handler) {
			return {
				success: false,
				data: "",
				error: `未知工具类型: ${params.type}`,
			};
		}

		// 五行 Permission Gate — 统一越权检查
		const permission = checkPermission({
			toolType: params.type,
			params: params as unknown as Record<string, unknown>,
			mode: this.mode,
			workDir: this.cwd,
		});

		if (!permission.allowed) {
			return {
				success: false,
				data: "",
				error: `五行 · 权限拒绝: ${permission.reason}`,
			};
		}

		// If the gate resolved a path, inject it into params so tools
		// don't need to re-resolve it themselves
		const effectiveParams = permission.resolvedPath
			? { ...params, resolvedPath: permission.resolvedPath }
			: params;

		// 五行 · 用户确认 — requireConfirm 时回调上层等待确认
		if (permission.requireConfirm && this.onPermissionConfirm) {
			const confirmed = await this.onPermissionConfirm(
				effectiveParams.type,
				effectiveParams,
				permission,
			);
			if (!confirmed) {
				return {
					success: false,
					data: "",
					error: `用户拒绝了操作: ${effectiveParams.type}`,
				};
			}
		}

		return handler(effectiveParams);
	}

	getAvailableTools(): string[] {
		return Array.from(this.handlers.keys());
	}

	// ===== 元数据 =====

	getDefinitions(): ToolDefinition[] {
		return Array.from(this.definitions.values());
	}

	getDefinition(type: string): ToolDefinition | undefined {
		return this.definitions.get(type);
	}

	// ===== MCP 集成 =====

	/** 连接 MCP 服务器并注册其工具到当前管理器 */
	async connectMCP(
		client: MCPClient,
	): Promise<{ serverName: string; toolsAdded: number }> {
		await client.connect();
		const mcpTools = await client.listTools();
		const serverInfo = client.getServerInfo();

		for (const tool of mcpTools) {
			const params = (
				tool.inputSchema.properties
					? Object.entries(tool.inputSchema.properties)
					: []
			).map(([name, prop]) => ({
				name,
				type: (prop.type || "string") as
					| "string"
					| "number"
					| "boolean"
					| "array"
					| "object",
				description: prop.description || "",
				required: tool.inputSchema.required?.includes(name) || false,
			}));

			this.define(
				{
					type: `mcp_${tool.name}`,
					name: tool.name,
					description: tool.description || `MCP 工具 (${serverInfo.name})`,
					parameters: params,
					examples: [],
					alwaysLoad: false,
					category: "earth",
				},
				async (p) => {
					try {
						const result = await client.callTool(
							tool.name,
							p as unknown as Record<string, unknown>,
						);
						const text = result.content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join("\n");
						return { success: !result.isError, data: text, duration: 0 };
					} catch (err: any) {
						return { success: false, data: "", error: err.message };
					}
				},
			);
		}

		return { serverName: serverInfo.name, toolsAdded: mcpTools.length };
	}

	/** 生成系统提示词中的工具说明部分 */
	generateToolPrompt(): string {
		const lines: string[] = ["## 可用工具"];
		const categories = ["metal", "wood", "water", "fire", "earth"] as const;
		const categoryNames: Record<string, string> = {
			metal: "文件系统",
			wood: "代码理解",
			water: "网络/数据",
			fire: "执行",
			earth: "协作",
		};

		for (const cat of categories) {
			const tools = Array.from(this.definitions.values()).filter(
				(d) => d.category === cat,
			);
			if (tools.length === 0) continue;

			lines.push("");
			lines.push(`【${categoryNames[cat]}】`);

			for (const tool of tools) {
				lines.push(`\`${tool.name}\`: ${tool.description}`);
				// 参数列表
				const paramStrs = tool.parameters.map((p) => {
					const required = p.required ? "（必填）" : "（可选）";
					const enumStr = p.enumValues ? ` [${p.enumValues.join("|")}]` : "";
					return `  - \`${p.name}\`: ${p.type}${required}${enumStr} — ${p.description}`;
				});
				if (paramStrs.length > 0) lines.push(...paramStrs);
				// 示例
				if (tool.examples.length > 0) {
					const ex = tool.examples[0];
					const exampleCall = JSON.stringify({ type: tool.type, ...ex.params });
					lines.push(`  示例: ${ex.description}`);
					lines.push(`  <tool_call>${exampleCall}</tool_call>`);
				}
				lines.push("");
			}
		}

		return lines.join("\n");
	}
}
