/**
 * MCP ToolRegistry — 将 @xuancode/tools 的 ToolManager 工具桥接到 MCP 协议格式
 */

import type { ToolManager } from "@xuancode/tools";
import type {
	ToolCallParams,
	ToolDefinition,
	ToolResult,
} from "@xuancode/types";
import type {
	MCPContentItem,
	MCPTool,
	MCPToolCallResult,
	MCPToolProperty,
} from "./types.js";

/** ToolParameter 的 MCP 类型映射 */
const TS_TYPE_TO_MCP: Record<string, string> = {
	string: "string",
	number: "number",
	boolean: "boolean",
	array: "array",
	object: "object",
};

// biome-ignore lint/complexity/noStaticOnlyClass: 无状态工具注册表，静态成员集合即其本质
export class MCPToolRegistry {
	/**
	 * 从 ToolManager 查询所有已注册的工具定义。
	 * 通过 getToolDefinitions() 获取完整元数据，映射为 MCP 格式。
	 */
	static listTools(tm: ToolManager): MCPTool[] {
		const defs = tm.getDefinitions();
		return defs.map((def) => MCPToolRegistry.definitionToMCP(def));
	}

	/** 将 @xuancode/types 的 ToolDefinition 转换为 MCPTool */
	static definitionToMCP(def: ToolDefinition): MCPTool {
		const properties: Record<string, MCPToolProperty> = {};
		const required: string[] = [];

		for (const p of def.parameters) {
			const mcpType = TS_TYPE_TO_MCP[p.type] || "string";
			const prop: MCPToolProperty = { type: mcpType };
			if (p.description) prop.description = p.description;
			if (p.enumValues && p.enumValues.length > 0) {
				prop.enum = [...p.enumValues];
				// MCP enum 要求 type 为 string
				prop.type = "string";
			}
			properties[p.name] = prop;
			if (p.required) required.push(p.name);
		}

		return {
			name: def.name,
			description: def.description,
			inputSchema: {
				type: "object",
				properties: Object.keys(properties).length > 0 ? properties : undefined,
				required: required.length > 0 ? required : undefined,
			},
		};
	}

	/**
	 * 执行 MCP tools/call 请求。
	 * name → ToolManager 的 tool type
	 * arguments → ToolCallParams
	 */
	static async callTool(
		tm: ToolManager,
		name: string,
		args: Record<string, unknown> | undefined,
	): Promise<MCPToolCallResult> {
		const params: ToolCallParams = {
			type: name,
			...(args || {}),
		} as ToolCallParams;

		try {
			const result: ToolResult = await tm.dispatch(params);
			const items: MCPContentItem[] = [];

			if (result.data) {
				items.push({ type: "text", text: result.data });
			}

			return {
				content: items,
				isError: !result.success,
			};
		} catch (err: any) {
			return {
				content: [{ type: "text", text: err.message || String(err) }],
				isError: true,
			};
		}
	}
}
