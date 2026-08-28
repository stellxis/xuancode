import type { DagNode, DagNodeStatus } from "./types";

/**
 * DAG 图结构 — 管理节点和依赖关系
 *
 * 功能:
 * - 添加/删除节点
 * - 添加边（依赖关系）
 * - 拓扑排序
 * - 查找就绪节点（所有依赖已完成的节点）
 * - 环检测
 */
export class DagGraph {
	private nodes: Map<string, DagNode> = new Map();
	private adjacency: Map<string, string[]> = new Map(); // nodeId -> children
	private reverseAdj: Map<string, string[]> = new Map(); // nodeId -> parents (dependencies)

	/** 添加节点，返回分配的 ID */
	addNode(
		node: Omit<
			DagNode,
			"status" | "attempts" | "result" | "error" | "startedAt" | "completedAt"
		>,
	): string {
		const full: DagNode = {
			...node,
			status: "pending",
			attempts: 0,
		};
		this.nodes.set(full.id, full);
		if (!this.adjacency.has(full.id)) this.adjacency.set(full.id, []);
		if (!this.reverseAdj.has(full.id)) this.reverseAdj.set(full.id, []);

		for (const depId of full.dependencies) {
			if (!this.adjacency.has(depId)) this.adjacency.set(depId, []);
			if (!this.reverseAdj.has(depId)) this.reverseAdj.set(depId, []);
			this.adjacency.get(depId)?.push(full.id);
			this.reverseAdj.get(full.id)?.push(depId);
		}

		return full.id;
	}

	/** 添加依赖边: from -> to (from 完成后 to 才能开始) */
	addEdge(fromId: string, toId: string): void {
		const from = this.nodes.get(fromId);
		const to = this.nodes.get(toId);
		if (!from || !to) throw new Error(`节点不存在: ${!from ? fromId : toId}`);

		if (!to.dependencies.includes(fromId)) {
			to.dependencies.push(fromId);
		}
		if (!this.adjacency.get(fromId)?.includes(toId)) {
			this.adjacency.get(fromId)?.push(toId);
		}
		if (!this.reverseAdj.get(toId)?.includes(fromId)) {
			this.reverseAdj.get(toId)?.push(fromId);
		}
	}

	/** 获取节点 */
	getNode(id: string): DagNode | undefined {
		return this.nodes.get(id);
	}

	/** 获取所有节点 */
	getAllNodes(): DagNode[] {
		return Array.from(this.nodes.values());
	}

	/** 获取节点数 */
	get size(): number {
		return this.nodes.size;
	}

	/** 获取子节点（直接下游） */
	getChildren(id: string): DagNode[] {
		return (this.adjacency.get(id) || [])
			.map((childId) => this.nodes.get(childId))
			.filter(Boolean) as DagNode[];
	}

	/** 获取父节点（直接上游/依赖） */
	getParents(id: string): DagNode[] {
		return (this.reverseAdj.get(id) || [])
			.map((parentId) => this.nodes.get(parentId))
			.filter(Boolean) as DagNode[];
	}

	/** 检查所有依赖是否已完成 */
	private areDependenciesMet(nodeId: string): boolean {
		const node = this.nodes.get(nodeId);
		if (!node) return false;
		for (const depId of node.dependencies) {
			const dep = this.nodes.get(depId);
			if (!dep || dep.status !== "completed") return false;
		}
		return true;
	}

	/** 获取所有就绪节点（依赖已满足且处于 pending 状态） */
	getReadyNodes(): DagNode[] {
		return this.getAllNodes().filter(
			(n) => n.status === "pending" && this.areDependenciesMet(n.id),
		);
	}

	/** 获取仍在运行或等待的节点数 */
	getPendingCount(): number {
		return this.getAllNodes().filter(
			(n) => n.status === "pending" || n.status === "running",
		).length;
	}

	/** 检查所有节点是否已完成（或跳过/失败） */
	isComplete(): boolean {
		return this.getAllNodes().every(
			(n) =>
				n.status === "completed" ||
				n.status === "skipped" ||
				n.status === "failed",
		);
	}

	/** 更新节点状态 */
	updateStatus(
		id: string,
		status: DagNodeStatus,
		result?: string,
		error?: string,
	): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.status = status;
		if (result !== undefined) node.result = result;
		if (error !== undefined) node.error = error;
		if (status === "running") node.startedAt = Date.now();
		if (status === "completed" || status === "failed")
			node.completedAt = Date.now();
	}

	/** 拓扑排序（Kahn 算法） */
	getTopologicalOrder(): string[] {
		const inDegree = new Map<string, number>();
		const queue: string[] = [];

		for (const node of this.getAllNodes()) {
			inDegree.set(node.id, node.dependencies.length);
			if (node.dependencies.length === 0) queue.push(node.id);
		}

		const result: string[] = [];
		while (queue.length > 0) {
			const id = queue.shift()!;
			result.push(id);
			for (const child of this.adjacency.get(id) || []) {
				const deg = (inDegree.get(child) || 1) - 1;
				inDegree.set(child, deg);
				if (deg === 0) queue.push(child);
			}
		}

		return result;
	}

	/** 环检测 — 拓扑排序后检查是否有节点未处理 */
	hasCycle(): boolean {
		return this.getTopologicalOrder().length !== this.nodes.size;
	}

	/** 获取节点的层级（root = 0，每加一层深度 +1） */
	getLevel(nodeId: string): number {
		const parents = this.getParents(nodeId);
		if (parents.length === 0) return 0;
		return 1 + Math.max(...parents.map((p) => this.getLevel(p.id)));
	}

	/** 按层级分组 */
	getLevelGroups(): DagNode[][] {
		const groups = new Map<number, DagNode[]>();
		for (const node of this.getAllNodes()) {
			const level = this.getLevel(node.id);
			if (!groups.has(level)) groups.set(level, []);
			groups.get(level)?.push(node);
		}
		return Array.from(groups.entries())
			.sort(([a], [b]) => a - b)
			.map(([, nodes]) => nodes);
	}
}
