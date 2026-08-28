import type { ToolDefinition } from "@xuancode/types";
import { describe, expect, it } from "vitest";
import { toAnthropicTools, toApiTools, toGeminiTools } from "./index";

const defs: ToolDefinition[] = [
	{
		type: "file",
		name: "read_file",
		description: "读取文件内容",
		parameters: [
			{ name: "path", type: "string", description: "文件路径", required: true },
			{
				name: "startLine",
				type: "number",
				description: "起始行",
				required: false,
			},
			{
				name: "mode",
				type: "string",
				description: "模式",
				required: false,
				enumValues: ["auto", "strict"],
			},
		],
		examples: [],
		alwaysLoad: false,
		category: "water",
	},
];

describe("工具 schema 转换器（C3 阵营格式）", () => {
	it("toApiTools: OpenAI 兼容 {type,function:{name,description,parameters}}", () => {
		const tools = toApiTools(defs);
		expect(tools[0]).toEqual({
			type: "function",
			function: {
				name: "read_file",
				description: "读取文件内容",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "文件路径" },
						startLine: { type: "number", description: "起始行" },
						mode: {
							type: "string",
							description: "模式",
							enum: ["auto", "strict"],
						},
					},
					required: ["path"],
				},
			},
		});
	});

	it("toAnthropicTools: Anthropic 用 input_schema 而非 parameters", () => {
		const tools = toAnthropicTools(defs);
		expect(tools[0]).toEqual({
			name: "read_file",
			description: "读取文件内容",
			input_schema: {
				type: "object",
				properties: {
					path: { type: "string", description: "文件路径" },
					startLine: { type: "number", description: "起始行" },
					mode: {
						type: "string",
						description: "模式",
						enum: ["auto", "strict"],
					},
				},
				required: ["path"],
			},
		});
	});

	it("toGeminiTools: Gemini functionDeclarations 的 parameters 形状", () => {
		const tools = toGeminiTools(defs);
		expect(tools[0]).toEqual({
			name: "read_file",
			description: "读取文件内容",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "文件路径" },
					startLine: { type: "number", description: "起始行" },
					mode: {
						type: "string",
						description: "模式",
						enum: ["auto", "strict"],
					},
				},
				required: ["path"],
			},
		});
	});
});
