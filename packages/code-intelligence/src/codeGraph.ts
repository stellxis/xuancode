import type { CodeChunk, DependencyGraph } from "./types";

// 同时兼容 POSIX（/）与 Windows（\）路径分隔符，统一为 "/" 输出
const SPLIT = /[/\\]/;

function toPosixPath(p: string): string {
	return p.replace(/\\/g, "/");
}

export function buildDependencyGraph(chunks: CodeChunk[]): DependencyGraph {
	const nodes = new Map<string, { path: string; type: "file" | "directory" }>();
	const edgeSet = new Set<string>();

	for (const chunk of chunks) {
		const filePath = toPosixPath(chunk.filePath);
		if (!nodes.has(filePath)) {
			nodes.set(filePath, { path: filePath, type: "file" });
		}

		const dir = filePath.split(SPLIT).slice(0, -1).join("/");
		if (dir && !nodes.has(dir)) {
			nodes.set(dir, { path: dir, type: "directory" });
		}

		for (const imp of chunk.imports) {
			let target = toPosixPath(imp);
			if (target.startsWith(".")) {
				const baseDir = filePath.split(SPLIT).slice(0, -1).join("/");
				target = resolveRelativePath(baseDir, target);
			}

			const parts = target.split(SPLIT);
			for (let i = 0; i < parts.length - 1; i++) {
				const dirPath = parts.slice(0, i + 1).join("/");
				if (dirPath && !nodes.has(dirPath)) {
					nodes.set(dirPath, { path: dirPath, type: "directory" });
				}
			}

			if (target && !nodes.has(target)) {
				nodes.set(target, { path: target, type: "file" });
			}

			if (target) {
				edgeSet.add(`${filePath}|${target}|import`);
			}
		}
	}

	const edges: DependencyGraph["edges"] = [];
	for (const edge of edgeSet) {
		const [from, to, type] = edge.split("|");
		edges.push({ from, to, type: type as "import" | "re-export" });
	}

	return {
		nodes: Array.from(nodes.values()),
		edges,
	};
}

export function findDependents(
	graph: DependencyGraph,
	filePath: string,
): string[] {
	return graph.edges
		.filter((e) => e.to === filePath)
		.map((e) => e.from)
		.filter((p) => graph.nodes.some((n) => n.path === p && n.type === "file"));
}

export function findDependencies(
	graph: DependencyGraph,
	filePath: string,
): string[] {
	return graph.edges
		.filter((e) => e.from === filePath)
		.map((e) => e.to)
		.filter((p) => graph.nodes.some((n) => n.path === p && n.type === "file"));
}

function resolveRelativePath(baseDir: string, target: string): string {
	const baseParts = baseDir.split("/").filter(Boolean);
	const targetParts = target.split("/");

	for (const part of targetParts) {
		if (part === ".") continue;
		if (part === "..") {
			baseParts.pop();
		} else {
			baseParts.push(part);
		}
	}

	return baseParts.join("/");
}

/**
 * 计算影响范围：给定一组被修改的文件，返回所有会受影响的文件（BFS 反向依赖闭包）。
 * 用于 Agent 重构前的影响面预估。
 *
 * @param graph 依赖图
 * @param changedFiles 即将被修改/删除/重命名的文件列表
 * @param maxDepth 最大展开深度（默认 8，防止循环依赖死循环）
 * @returns { direct, transitive, total } direct=直接依赖, transitive=间接传递, total=总计
 */
export function findAffectedFiles(
	graph: DependencyGraph,
	changedFiles: string[],
	maxDepth = 8,
): { direct: string[]; transitive: string[]; total: string[] } {
	const changed = new Set(changedFiles.map(toPosixPath));
	const visited = new Set<string>();
	const direct = new Set<string>();
	const queue: { file: string; depth: number }[] = [];

	for (const f of changed) {
		queue.push({ file: f, depth: 0 });
	}

	while (queue.length > 0) {
		const { file, depth } = queue.shift()!;
		if (visited.has(file)) continue;
		visited.add(file);
		if (depth > maxDepth) continue;

		const dependents = graph.edges
			.filter((e) => e.to === file)
			.map((e) => e.from)
			.filter((p) =>
				graph.nodes.some((n) => n.path === p && n.type === "file"),
			);

		for (const dep of dependents) {
			if (depth === 0 && !changed.has(dep)) {
				direct.add(dep);
			}
			if (!visited.has(dep)) {
				queue.push({ file: dep, depth: depth + 1 });
			}
		}
	}

	const transitive = [...visited].filter(
		(f) => !changed.has(f) && !direct.has(f),
	);
	const total = [...visited].filter((f) => !changed.has(f));

	return {
		direct: [...direct],
		transitive,
		total,
	};
}
