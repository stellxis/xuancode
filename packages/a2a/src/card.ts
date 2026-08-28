/**
 * Agent Card 生成器
 *
 * 从 ToolManager 的工具定义自动生成 AgentCard，
 * 用于 A2A 协议的服务发现。
 */

import type { ToolManager } from "@xuancode/tools";
import type { AgentCard, AgentSkill } from "./types.js";

/** 五行分类映射 */
const ELEMENT_LABELS: Record<string, string> = {
	metal: "文件读写与编辑",
	wood: "代码搜索与理解",
	water: "网络与数据获取",
	fire: "命令执行与版本控制",
	earth: "协作与插件",
};

/** 从 ToolManager 生成 AgentCard */
export function generateAgentCard(
	toolManager: ToolManager,
	options?: {
		name?: string;
		description?: string;
		providerName?: string;
		streaming?: boolean;
	},
): AgentCard {
	const tools = toolManager.getDefinitions();

	const skills: AgentSkill[] = tools.map((t) => ({
		name: t.name,
		description: t.description,
		element: t.category,
		inputs: t.parameters.map((p) => ({
			name: p.name,
			type: p.type,
			description: p.description,
			required: p.required,
		})),
	}));

	return {
		version: "1.0",
		name: options?.name || "玄码 AI Agent",
		description:
			options?.description ||
			"通用 AI Agent 编排平台，支持代码编辑、文件操作、命令执行、网络搜索和版本控制。",
		skills,
		streaming: options?.streaming ?? true,
	};
}
