import fs from "node:fs";
import path from "node:path";
import {
	CURRENT_INDEX_VERSION,
	type CodeIndex,
	INDEX_PERF_DEFAULTS,
	type SearchResult,
	buildDependencyGraph,
	buildIndexInBackground,
	findAffectedFiles,
	loadIndex,
	saveIndex,
	search,
	searchWithContext,
} from "@xuancode/code-intelligence";
import { setSearchProvider } from "@xuancode/tools";

export class CodeIntelligenceService {
	private index: CodeIndex | null = null;
	private indexing = false;
	private aborted = false;
	private indexProgress = { processed: 0, total: 0, currentFile: "" };

	constructor(
		private workDir: string,
		private indexPath: string,
	) {
		const cached = loadIndex(indexPath);
		// 验证缓存的 workDir 与索引版本是否匹配，不匹配则丢弃缓存重建
		if (
			cached &&
			cached.workDir === workDir &&
			cached.version === CURRENT_INDEX_VERSION
		) {
			this.index = cached;
		}
		setSearchProvider((query, contextPath) =>
			this.doSearch(query, contextPath),
		);
	}

	async ensureIndex(): Promise<void> {
		if (this.index) return;
		if (this.indexing) return;

		this.indexing = true;
		this.aborted = false;
		const service = this;

		try {
			// 增量索引：复用磁盘上缓存的索引，仅重新解析 mtime 变化的文件
			const previous = loadIndex(this.indexPath);
			this.index = await buildIndexInBackground(this.workDir, {
				previousIndex: previous,
				maxFiles: INDEX_PERF_DEFAULTS.maxFiles,
				maxDepth: INDEX_PERF_DEFAULTS.maxDepth,
				timeoutMs: INDEX_PERF_DEFAULTS.timeoutMs,
				onProgress: (processed, total, currentFile) => {
					service.indexProgress = { processed, total, currentFile };
				},
				signal: {
					get aborted() {
						return service.aborted;
					},
				} as AbortSignal,
			});

			const dir = path.dirname(this.indexPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			saveIndex(this.index, this.indexPath);
		} finally {
			this.indexing = false;
		}
	}

	/** 强制重建（增量：仅重解析已变更文件） */
	async rebuild(): Promise<void> {
		this.index = null;
		await this.ensureIndex();
	}

	abortIndexing(): void {
		this.aborted = true;
	}

	getStatus(): {
		ready: boolean;
		indexing: boolean;
		progress: string;
		totalChunks: number;
		totalFiles: number;
	} {
		return {
			ready: this.index !== null,
			indexing: this.indexing,
			progress: this.indexing
				? `处理 ${this.indexProgress.processed}/${this.indexProgress.total} 个文件`
				: this.index
					? `已索引 ${this.index.totalFiles} 个文件，${this.index.totalChunks} 个代码块`
					: "未索引",
			totalChunks: this.index?.totalChunks ?? 0,
			totalFiles: this.index?.totalFiles ?? 0,
		};
	}

	getGraph(): {
		nodes: { path: string; type: "file" | "directory" }[];
		edges: { from: string; to: string; type: "import" | "re-export" }[];
		httpCalls: {
			path: string;
			callee: string;
			method: string;
			url: string | null;
			line: number;
		}[];
	} {
		if (!this.index) return { nodes: [], edges: [], httpCalls: [] };
		const graph = buildDependencyGraph(this.index.chunks);
		// 汇总各文件级 chunk 上的 HTTP 调用点（供前端接口调用链路追踪）
		const httpCalls: {
			path: string;
			callee: string;
			method: string;
			url: string | null;
			line: number;
		}[] = [];
		for (const chunk of this.index.chunks) {
			if (!chunk.httpCalls || chunk.httpCalls.length === 0) continue;
			const posix = chunk.filePath.replace(/\\/g, "/");
			for (const c of chunk.httpCalls) {
				httpCalls.push({
					path: posix,
					callee: c.callee,
					method: c.method,
					url: c.url,
					line: c.line,
				});
			}
		}
		return { ...graph, httpCalls };
	}

	/**
	 * 计算影响范围：给定一组被修改的文件，返回所有会受影响的上游依赖文件。
	 * 用于 Agent 重构前的影响面预估。
	 */
	findAffectedFiles(
		changedFiles: string[],
		maxDepth = 8,
	): {
		direct: string[];
		transitive: string[];
		total: string[];
	} {
		if (!this.index) {
			return { direct: [], transitive: [], total: [] };
		}
		const graph = buildDependencyGraph(this.index.chunks);
		return findAffectedFiles(graph, changedFiles, maxDepth);
	}

	async search(
		query: string,
		contextPath?: string,
		topK = 10,
	): Promise<SearchResult[]> {
		if (!this.index) {
			await this.ensureIndex();
			if (!this.index) return [];
		}
		return searchWithContext(this.index, query, contextPath, topK);
	}

	private async doSearch(
		query: string,
		contextPath?: string,
	): Promise<SearchResult[]> {
		return this.search(query, contextPath);
	}

	destroy(): void {
		this.aborted = true;
		this.index = null;
	}
}
