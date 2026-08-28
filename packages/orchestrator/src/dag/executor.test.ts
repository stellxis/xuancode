import { describe, expect, it } from "vitest";
import { DagExecutor } from "./executor";
import { DagGraph } from "./graph";

/** 构建链式依赖图：A → B → C，另加独立节点 E 与 A 的子节点 D */
function buildGraph(): DagGraph {
	const g = new DagGraph();
	g.addNode({
		id: "A",
		label: "分析",
		instruction: "[nA] 分析代码",
		subAgentType: "explore",
		dependencies: [],
	});
	g.addNode({
		id: "B",
		label: "实现",
		instruction: "[nB] 实现功能",
		subAgentType: "implement",
		dependencies: ["A"],
	});
	g.addNode({
		id: "C",
		label: "审查",
		instruction: "[nC] 审查代码",
		subAgentType: "review",
		dependencies: ["B"],
	});
	g.addNode({
		id: "D",
		label: "测试",
		instruction: "[nD] 编写测试",
		subAgentType: "test",
		dependencies: ["A"],
	});
	g.addNode({
		id: "E",
		label: "文档",
		instruction: "[nE] 写文档",
		subAgentType: "docs",
		dependencies: [],
	});
	return g;
}

/** 可编程的假 scheduler：按指令中的标记 [nX] 记录尝试次数，并按规则抛错 */
function fakeSchedulerFactory(opts: {
	alwaysFail?: string[];
	failFirst?: string[];
}) {
	const attempts: Record<string, number> = {};
	const calls: string[] = [];
	return {
		factory: () => ({
			delegate: async (_type: unknown, instruction: string) => {
				const marker = instruction.match(/\[n([A-Z])\]/)?.[1] || "?";
				attempts[marker] = (attempts[marker] || 0) + 1;
				const nth = attempts[marker];
				calls.push(`${marker}#${nth}`);
				if (opts.alwaysFail?.includes(marker))
					throw new Error(`[n${marker}] 持续失败`);
				if (opts.failFirst?.includes(marker) && nth === 1)
					throw new Error(`[n${marker}] 首次失败`);
				return `结果 ${marker}#${nth}`;
			},
		}),
		calls,
		attempts,
	};
}

function baseConfig(scheduler: any, overrides: any = {}) {
	return {
		maxConcurrency: 4,
		modelFactory: () => ({}),
		workDir: "/tmp",
		schedulerFactory: scheduler.factory,
		...overrides,
	};
}

describe("DagExecutor 失败级联修复", () => {
	it("无失败 → 全部完成，无跳过", async () => {
		const g = buildGraph();
		const sched = fakeSchedulerFactory({});
		const ex = new DagExecutor(g, baseConfig(sched) as any);
		const res = await ex.execute();
		expect(res.success).toBe(true);
		expect(res.failedNodes).toEqual([]);
		expect(res.skippedNodes).toEqual([]);
		expect(sched.calls).toEqual(["A#1", "E#1", "B#1", "D#1", "C#1"]);
	});

	it("首次失败自动重试 → 第二次成功，任务完成", async () => {
		const g = buildGraph();
		const sched = fakeSchedulerFactory({ failFirst: ["A"] });
		const ex = new DagExecutor(
			g,
			baseConfig(sched, { maxNodeRetries: 2 }) as any,
		);
		const res = await ex.execute();
		expect(res.success).toBe(true);
		expect(res.failedNodes).toEqual([]);
		// A 重试了一次（共 2 次尝试），下游正常执行
		expect(sched.attempts.A).toBe(2);
		expect(sched.calls).toContain("A#2");
		expect(g.getNode("B")?.status).toBe("completed");
	});

	it("重试时注入修复提示", async () => {
		const g = buildGraph();
		const seenInstructions: string[] = [];
		const custom = {
			factory: () => ({
				delegate: async (_type: unknown, instruction: string) => {
					const marker = instruction.match(/\[n([A-Z])\]/)?.[1] || "?";
					if (marker === "A") {
						seenInstructions.push(instruction);
						if (seenInstructions.length === 1) throw new Error("[nA] 首次失败");
					}
					return `结果 ${marker}`;
				},
			}),
		};
		const ex = new DagExecutor(
			g,
			baseConfig(custom, { maxNodeRetries: 2 }) as any,
		);
		await ex.execute();
		expect(seenInstructions.length).toBe(2);
		expect(seenInstructions[1]).toContain("[修复要求]");
		expect(seenInstructions[1]).toContain("上一次执行失败");
		expect(seenInstructions[1]).toContain("[nA] 首次失败");
	});

	it("重试耗尽 → 节点失败，下游级联 skipped", async () => {
		const g = buildGraph();
		const sched = fakeSchedulerFactory({ alwaysFail: ["A"] });
		const skipped: string[] = [];
		const ex = new DagExecutor(
			g,
			baseConfig(sched, {
				maxNodeRetries: 1, // 共 2 次尝试
				onNodeSkipped: (node: any) => skipped.push(node.id),
			}) as any,
		);
		const res = await ex.execute();
		expect(res.success).toBe(false);
		expect(res.failedNodes).toEqual(["A"]);
		// B、C、D 是 A 的传递下游 → 全部跳过；E 独立 → 正常完成
		expect([...res.skippedNodes].sort()).toEqual(["B", "C", "D"]);
		expect([...skipped].sort()).toEqual(["B", "C", "D"]);
		expect(sched.attempts.A).toBe(2);
		expect(g.getNode("E")?.status).toBe("completed");
		expect(g.getNode("B")?.status).toBe("skipped");
		expect(g.getNode("C")?.status).toBe("skipped");
		expect(g.getNode("D")?.status).toBe("skipped");
	});

	it("maxNodeRetries=0 → 失败即放弃，不重试", async () => {
		const g = buildGraph();
		const sched = fakeSchedulerFactory({ alwaysFail: ["B"] });
		const ex = new DagExecutor(
			g,
			baseConfig(sched, { maxNodeRetries: 0 }) as any,
		);
		const res = await ex.execute();
		expect(res.success).toBe(false);
		expect(res.failedNodes).toEqual(["B"]);
		expect(sched.attempts.B).toBe(1);
		// C 依赖 B → 级联跳过
		expect([...res.skippedNodes].sort()).toEqual(["C"]);
	});
});
