import { DagGraph } from "./graph";
/**
 * DAG 任务分解引擎
 *
 * 将复杂任务自动分解为 DAG（有向无环图）子任务。
 * 支持两种策略:
 *   1. LLM 分解 — 调用模型分析任务依赖关系
 *   2. 启发式分解 — 模式匹配（fallback）
 */
import type { DagDecomposeResult, DagNode } from "./types";

const DECOMPOSE_PROMPT = `你是一个任务分解专家。请将以下用户任务拆解为多个可独立执行的子任务。

要求:
1. 识别任务中的独立步骤和依赖关系
2. 每个子任务应职责单一、边界清晰
3. 标注子任务之间的依赖关系
4. 选择合适子 Agent 类型 (explore/plan/implement/review/security/test/docs/debug)
5. 为每个子任务写清晰的指令

输出 JSON 格式（仅 JSON，不要其他内容）:
{
  "summary": "总体分解策略说明",
  "nodes": [
    {
      "id": "step-1",
      "label": "简短描述",
      "instruction": "完整的子任务指令",
      "subAgentType": "explore|plan|implement|review|security",
      "dependencies": []
    }
  ]
}

注意事项:
- dependencies 数组填写依赖的节点 ID，根节点为空数组
- 无依赖的节点可以并行执行
- subAgentType 取值: explore(代码搜索/阅读), plan(方案设计), implement(编码实现), review(代码审查), security(安全审计), test(测试编写), docs(文档编写), debug(调试修复)
- instruction 应当足够详细，让子 Agent 无需额外上下文即可执行`;

/** 使用 LLM 分解任务 */
export async function decomposeWithLLM(
	taskInput: string,
	model: {
		chat: (
			messages: Array<{ role: string; content: string }>,
		) => Promise<string>;
	},
): Promise<DagDecomposeResult> {
	const response = await model.chat([
		{ role: "system", content: DECOMPOSE_PROMPT },
		{ role: "user", content: `请分解以下任务:\n\n${taskInput}` },
	]);

	return parseDecomposeResponse(response, taskInput);
}

/** 解析 LLM 返回的 JSON */
function parseDecomposeResponse(
	response: string,
	fallbackInput: string,
): DagDecomposeResult {
	// 提取 JSON
	const jsonMatch = response.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		return fallbackDecompose(fallbackInput);
	}

	try {
		const parsed = JSON.parse(jsonMatch[0]);
		const nodes: DagNode[] = (parsed.nodes || []).map((n: any) => ({
			id: n.id || `step-${Math.random().toString(36).slice(2, 6)}`,
			label: n.label || n.id || "子任务",
			instruction: n.instruction || fallbackInput,
			subAgentType: [
				"explore",
				"plan",
				"implement",
				"review",
				"security",
				"test",
				"docs",
				"debug",
			].includes(n.subAgentType)
				? n.subAgentType
				: "implement",
			dependencies: Array.isArray(n.dependencies) ? n.dependencies : [],
			status: "pending" as const,
			attempts: 0,
		}));

		if (nodes.length === 0) return fallbackDecompose(fallbackInput);

		return {
			nodes,
			summary: parsed.summary || `分解为 ${nodes.length} 个子任务`,
		};
	} catch {
		return fallbackDecompose(fallbackInput);
	}
}

/** 启发式分解 — 通过关键词匹配拆解 */
function fallbackDecompose(input: string): DagDecomposeResult {
	const separators = [
		/\n(?:然后|接着|之后|再)\s+/,
		/\n(?:同时|并且|另外)\s+/,
		/(?:首先|第一步)\s*.+?\n(?:第二步|然后)/,
		/\n\d+[.、]/,
		/[.。]\s*(?:Then|Next|After that|Meanwhile)\s+/i,
	];

	let segments: string[] = [input];

	for (const sep of separators) {
		if (input.match(sep)) {
			segments = input
				.split(sep)
				.map((s) => s.trim())
				.filter(Boolean);
			if (segments.length >= 2) break;
		}
	}

	if (segments.length < 2) {
		// 无法分解，返回单节点
		return {
			nodes: [
				{
					id: "step-1",
					label: "执行任务",
					instruction: input,
					subAgentType: "implement",
					dependencies: [],
					status: "pending",
					attempts: 0,
				},
			],
			summary: "单一任务（无法分解）",
		};
	}

	const nodes: DagNode[] = segments.map((seg, i) => ({
		id: `step-${i + 1}`,
		label: seg.slice(0, 40) + (seg.length > 40 ? "..." : ""),
		instruction: seg,
		subAgentType: i === 0 ? "plan" : "implement",
		dependencies: i === 0 ? [] : [`step-${i}`],
		status: "pending" as const,
		attempts: 0,
	}));

	return {
		nodes,
		summary: `启发式分解为 ${nodes.length} 个串行子任务`,
	};
}

/** 检查是否需要分解（根据任务复杂度判断） */
export function shouldDecompose(input: string, modePreset?: string): boolean {
	if (modePreset === "local") return true; // 本地模式总是分解
	if (modePreset === "smart") return input.length > 200; // 主流模式，长任务才分解

	// 标准模式: 仅当任务明显需要多步骤时才分解
	const complexityIndicators = [
		/\n(?:然后|接着|同时|另外)/,
		/(?:重构|实现|创建|构建|搭建).{10,}(?:和|与|并).{10,}(?:功能|模块|页面)/,
		/(?:第一步|第二步|步骤[一二三])/,
		/(?:先|然后|再|最后).{5,}(?:再|然后)/,
		/\d+\s*(?:个|项|种).{0,10}(?:功能|模块|接口|页面)/,
		input.length > 500,
	];

	return complexityIndicators.some((ind) =>
		typeof ind === "boolean" ? ind : ind.test(input),
	);
}

/** 验证 DAG 图是否有效 */
export function validateDag(nodes: DagNode[]): {
	valid: boolean;
	error?: string;
} {
	if (nodes.length === 0) return { valid: false, error: "空 DAG" };
	if (nodes.length > 32)
		return { valid: false, error: "子任务过多（最多 32 个）" };

	const graph = new DagGraph();
	for (const n of nodes) graph.addNode(n);

	if (graph.hasCycle()) return { valid: false, error: "DAG 存在循环依赖" };

	const ids = new Set(nodes.map((n) => n.id));
	for (const n of nodes) {
		for (const dep of n.dependencies) {
			if (!ids.has(dep))
				return { valid: false, error: `依赖节点不存在: ${dep} -> ${n.id}` };
		}
	}

	return { valid: true };
}
