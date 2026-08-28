/**
 * DAG 执行引擎
 *
 * 按拓扑顺序并行执行 DAG 节点：
 * 1. 持续查找就绪节点（依赖已完成的节点）
 * 2. 并行启动不超过 maxConcurrency 个就绪节点
 * 3. 每个节点通过 SubAgentScheduler.delegate() 执行
 * 4. 节点失败时自动重试（注入修复提示），重试耗尽后失败并级联跳过下游
 */
import type { DagGraph } from "./graph";
import type { DagExecConfig, DagExecResult, DagNode } from "./types";

export class DagExecutor {
	private graph: DagGraph;
	private config: DagExecConfig;
	private nodeResults: Map<string, string> = new Map();
	private failedNodes: string[] = [];
	private skippedNodes: string[] = [];
	private runningCount = 0;
	private startTime = 0;
	private maxRetries: number;

	constructor(graph: DagGraph, config: DagExecConfig) {
		this.graph = graph;
		this.config = config;
		this.maxRetries = config.maxNodeRetries ?? 2;
	}

	/** 执行整个 DAG */
	async execute(): Promise<DagExecResult> {
		this.startTime = Date.now();

		if (this.graph.hasCycle()) {
			return {
				success: false,
				nodeResults: this.nodeResults,
				failedNodes: this.graph.getAllNodes().map((n) => n.id),
				skippedNodes: this.skippedNodes,
				duration: 0,
			};
		}

		await this.executeLevels();

		return {
			success: this.failedNodes.length === 0,
			nodeResults: this.nodeResults,
			failedNodes: this.failedNodes,
			skippedNodes: this.skippedNodes,
			duration: Date.now() - this.startTime,
		};
	}

	/** 按层级执行 */
	private async executeLevels(): Promise<void> {
		const levels = this.graph.getLevelGroups();

		for (const level of levels) {
			const promises = level.map(async (node) => {
				// 依赖已失败/被跳过 → 本级节点无法运行，级联跳过
				if (this.hasFailedDependency(node)) {
					this.cascadeSkipFrom(node.id, "依赖节点失败，级联跳过");
					return;
				}
				await this.executeNode(node);
			});
			await Promise.all(promises);
		}
	}

	/** 节点的任一依赖已失败或被跳过 */
	private hasFailedDependency(node: DagNode): boolean {
		return node.dependencies.some((depId) => {
			const dep = this.graph.getNode(depId);
			return !!dep && (dep.status === "failed" || dep.status === "skipped");
		});
	}

	/** 执行单个节点（失败自动重试，重试耗尽后级联跳过下游） */
	private async executeNode(node: DagNode): Promise<void> {
		const maxAttempts = this.maxRetries + 1;
		let lastError = "";

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const scheduler = this.createScheduler(node);
			node.attempts = attempt;
			this.graph.updateStatus(node.id, "running");
			this.runningCount++;
			this.config.onNodeStart?.(node);

			try {
				// 重试时注入修复提示，让子代理感知上一次的失败原因
				const instruction =
					attempt === 1
						? node.instruction
						: `${node.instruction}\n\n[修复要求]\n上一次执行失败：${lastError}\n请定位失败原因并修复后重试。`;
				const result = await scheduler.delegate(
					node.subAgentType as any,
					instruction,
					"sync",
				);

				this.graph.updateStatus(node.id, "completed", result);
				this.nodeResults.set(node.id, result);
				this.config.onNodeComplete?.({ ...node, result });
				return;
			} catch (err: any) {
				lastError = err.message || "未知执行错误";
				this.config.onNodeError?.({ ...node, error: lastError }, lastError);
			} finally {
				this.runningCount--;
			}
		}

		// 重试耗尽 → 失败 + 级联跳过下游
		this.graph.updateStatus(node.id, "failed", undefined, lastError);
		this.nodeResults.set(node.id, `[失败] ${lastError}`);
		this.failedNodes.push(node.id);
		this.cascadeSkipFrom(
			node.id,
			`依赖节点「${node.label}」执行失败，级联跳过`,
		);
	}

	/** 级联跳过：把 nodeId 的所有传递下游标记为 skipped（依赖已失败，继续执行无意义） */
	private cascadeSkipFrom(nodeId: string, reason: string): void {
		const visited = new Set<string>();
		const stack = [...this.graph.getChildren(nodeId)];

		while (stack.length > 0) {
			const child = stack.pop()!;
			if (visited.has(child.id)) continue;
			visited.add(child.id);

			if (child.status === "pending") {
				this.graph.updateStatus(child.id, "skipped", undefined, reason);
				this.skippedNodes.push(child.id);
				this.config.onNodeSkipped?.(child, reason);
			}

			// 已完成的节点保持不动；其余继续向下传播
			if (child.status !== "completed") {
				stack.push(...this.graph.getChildren(child.id));
			}
		}
	}

	/** 创建 SubAgentScheduler 实例 */
	private createScheduler(node: DagNode): any {
		// 优先使用外部注入的 schedulerFactory
		if (this.config.schedulerFactory) {
			return this.config.schedulerFactory(
				this.config.modelFactory,
				this.config.workDir,
			);
		}
		// 回退: 动态 require（兼容 CJS/ESM）
		try {
			const { SubAgentScheduler } = require("@xuancode/subagent");
			return new SubAgentScheduler(
				this.config.modelFactory,
				this.config.workDir,
			);
		} catch {
			throw new Error(
				"DagExecutor 需要 @xuancode/subagent 包或提供 schedulerFactory",
			);
		}
	}
}
