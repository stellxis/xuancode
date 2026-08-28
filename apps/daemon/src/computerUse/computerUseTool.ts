import type { ToolDefinition, ToolResult } from "@xuancode/types";
import type { ComputerUseService } from "./computerUseService";

type Handler = (params: Record<string, unknown>) => Promise<ToolResult>;

interface ExtraDef {
	def: ToolDefinition;
	handler: Handler;
}

function def(
	name: string,
	description: string,
	params: ToolDefinition["parameters"],
	handler: Handler,
): ExtraDef {
	return {
		def: {
			type: name,
			name,
			description,
			parameters: params,
			examples: [],
			alwaysLoad: false,
			category: "fire",
		},
		handler,
	};
}

export function createComputerUseExtraDefinitions(
	service: ComputerUseService,
): ExtraDef[] {
	return [
		def(
			"computer_use_screenshot",
			"截取当前屏幕，返回 PNG 格式的 base64 图片数据，可用于 AI 分析屏幕内容",
			[],
			() => service.takeScreenshot(),
		),

		def(
			"computer_use_mouse_move",
			"移动鼠标到指定绝对坐标 (x, y)。坐标原点为屏幕左上角。",
			[
				{
					name: "x",
					type: "number",
					description: "目标位置 X 坐标（像素）",
					required: true,
				},
				{
					name: "y",
					type: "number",
					description: "目标位置 Y 坐标（像素）",
					required: true,
				},
			],
			(params) => service.mouseMove(params.x as number, params.y as number),
		),

		def(
			"computer_use_mouse_click",
			"在当前鼠标位置执行点击操作。可指定左键、右键或双击。",
			[
				{
					name: "button",
					type: "string",
					description: "点击类型: left (左键), right (右键), double (双击)",
					required: false,
					default: "left",
					enumValues: ["left", "right", "double"],
				},
			],
			(params) =>
				service.mouseClick(
					(params.button as "left" | "right" | "double") || "left",
				),
		),

		def(
			"computer_use_drag",
			"从起点 (x1,y1) 拖拽到终点 (x2,y2)，用于选中文本或拖拽文件。",
			[
				{
					name: "x1",
					type: "number",
					description: "起点 X 坐标",
					required: true,
				},
				{
					name: "y1",
					type: "number",
					description: "起点 Y 坐标",
					required: true,
				},
				{
					name: "x2",
					type: "number",
					description: "终点 X 坐标",
					required: true,
				},
				{
					name: "y2",
					type: "number",
					description: "终点 Y 坐标",
					required: true,
				},
			],
			(params) =>
				service.mouseDrag(
					params.x1 as number,
					params.y1 as number,
					params.x2 as number,
					params.y2 as number,
				),
		),

		def(
			"computer_use_scroll",
			"滚动鼠标滚轮。正数为向上/右滚动，负数为向下/左滚动。",
			[
				{
					name: "deltaX",
					type: "number",
					description: "水平滚动量",
					required: false,
					default: 0,
				},
				{
					name: "deltaY",
					type: "number",
					description: "垂直滚动量",
					required: false,
					default: 1,
				},
			],
			(params) =>
				service.scroll(
					(params.deltaX as number) || 0,
					(params.deltaY as number) || 1,
				),
		),

		def(
			"computer_use_type",
			"在当前焦点位置输入指定的文本内容。会自动转义特殊字符。",
			[
				{
					name: "text",
					type: "string",
					description: "要输入的文本内容",
					required: true,
				},
			],
			(params) => service.typeText((params.text as string) || ""),
		),

		def(
			"computer_use_key",
			"模拟按键操作。支持组合键如 ctrl+c, alt+tab。",
			[
				{
					name: "key",
					type: "string",
					description:
						"按键名: enter, tab, escape, up, down, left, right, backspace, delete, f1-f24, 或组合键 ctrl+c, alt+tab, shift+a 等",
					required: true,
				},
			],
			(params) => service.pressKey((params.key as string) || ""),
		),

		def(
			"computer_use_screen_size",
			"获取主屏幕的尺寸信息，返回 { width, height, left, top }",
			[],
			() => service.getScreenSize(),
		),
	];
}
