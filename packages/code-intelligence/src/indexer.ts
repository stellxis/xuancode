import fs from "node:fs";
import path from "node:path";
import { chunkFile, tokenize } from "./chunker";
import type { CodeChunk, CodeIndex, IndexOptions } from "./types";
import {
	CURRENT_INDEX_VERSION,
	DEFAULT_SKIP_DIRS,
	INDEX_PERF_DEFAULTS,
	SUPPORTED_EXTENSIONS,
} from "./types";

export function buildIndex(rootDir: string, options?: IndexOptions): CodeIndex {
	const skipDirs = options?.skipDirs ?? DEFAULT_SKIP_DIRS;
	const extensions = options?.extensions ?? SUPPORTED_EXTENSIONS;
	const maxFiles = options?.maxFiles ?? INDEX_PERF_DEFAULTS.maxFiles;
	const maxDepth = options?.maxDepth ?? INDEX_PERF_DEFAULTS.maxDepth;

	const allChunks: CodeChunk[] = [];
	const filePaths = collectFiles(
		rootDir,
		skipDirs,
		extensions,
		maxDepth,
		maxFiles,
	);

	const timeoutMs = options?.timeoutMs ?? INDEX_PERF_DEFAULTS.timeoutMs;
	const deadline = Date.now() + timeoutMs;

	for (const fp of filePaths) {
		if (Date.now() > deadline) break;
		try {
			const content = fs.readFileSync(fp, "utf-8");
			const chunks = chunkFile(fp, content);
			allChunks.push(...chunks);
		} catch {
			// skip unreadable files
		}
		options?.onProgress?.(allChunks.length, filePaths.length * 2, fp);
	}

	const invertedIndex = new Map<string, string[]>();
	const docFreq = new Map<string, number>();

	for (const chunk of allChunks) {
		const seen = new Set<string>();
		for (const token of chunk.tokens) {
			if (!invertedIndex.has(token)) {
				invertedIndex.set(token, []);
			}
			invertedIndex.get(token)?.push(chunk.id);
			if (!seen.has(token)) {
				seen.add(token);
				docFreq.set(token, (docFreq.get(token) || 0) + 1);
			}
		}
	}

	const totalFiles = new Set(allChunks.map((c) => c.filePath)).size;

	return {
		chunks: allChunks,
		invertedIndex,
		docFreq,
		totalChunks: allChunks.length,
		totalFiles,
		indexedAt: Date.now(),
		version: CURRENT_INDEX_VERSION,
		workDir: rootDir,
	};
}

export async function buildIndexInBackground(
	rootDir: string,
	options?: IndexOptions & { signal?: AbortSignal },
): Promise<CodeIndex> {
	const skipDirs = options?.skipDirs ?? DEFAULT_SKIP_DIRS;
	const extensions = options?.extensions ?? SUPPORTED_EXTENSIONS;
	const previous = options?.previousIndex ?? null;
	const prevMtimes = previous?.fileMtimes;

	const perfMaxFiles = options?.maxFiles ?? INDEX_PERF_DEFAULTS.maxFiles;
	const perfMaxDepth = options?.maxDepth ?? INDEX_PERF_DEFAULTS.maxDepth;
	const perfTimeout = options?.timeoutMs ?? INDEX_PERF_DEFAULTS.timeoutMs;

	// 大仓库自动降级：先收集全部文件路径，若超过阈值则缩减深度重新收集
	let filePaths = collectFiles(
		rootDir,
		skipDirs,
		extensions,
		perfMaxDepth,
		perfMaxFiles,
	);
	let effectiveDepth = perfMaxDepth;
	if (filePaths.length > INDEX_PERF_DEFAULTS.degradeFileThreshold) {
		const degraded = INDEX_PERF_DEFAULTS.degradeDepth;
		if (degraded < perfMaxDepth) {
			filePaths = collectFiles(
				rootDir,
				skipDirs,
				extensions,
				degraded,
				perfMaxFiles,
			);
			effectiveDepth = degraded;
		}
	}
	const total = filePaths.length;
	const deadline = Date.now() + perfTimeout;

	const allChunks: CodeChunk[] = [];
	const fileMtimes: Record<string, number> = {};

	// 增量：保留 mtime 未变化的文件的旧 chunks
	const reusedChunks: CodeChunk[] = [];
	let skipped = 0;
	let timedOut = false;

	for (let i = 0; i < filePaths.length; i++) {
		if (options?.signal?.aborted) {
			throw new Error("Index build aborted");
		}
		if (Date.now() > deadline) {
			timedOut = true;
			break;
		}

		const fp = filePaths[i];
		try {
			const stat = fs.statSync(fp);
			const mtime = stat.mtimeMs;
			fileMtimes[fp] = mtime;

			// 增量命中：mtime 未变且旧索引中已有该文件，直接复用
			if (prevMtimes && prevMtimes[fp] === mtime) {
				const oldChunks = previous?.chunks.filter((c) => c.filePath === fp);
				if (oldChunks && oldChunks.length > 0) {
					reusedChunks.push(...oldChunks);
					skipped++;
					continue;
				}
			}

			const content = fs.readFileSync(fp, "utf-8");
			const chunks = chunkFile(fp, content);
			allChunks.push(...chunks);
		} catch {
			// skip unreadable files
		}

		if (i % 20 === 0) {
			await yieldToEventLoop();
		}

		options?.onProgress?.(i + 1, total, fp);
	}

	// 超时或截断：把未处理的文件也从旧索引中复用（保留 mtime 缓存）
	if ((timedOut || total < filePaths.length) && prevMtimes) {
		for (const fp of filePaths) {
			if (fileMtimes[fp] !== undefined) continue;
			const oldChunks = previous?.chunks.filter((c) => c.filePath === fp);
			if (oldChunks && oldChunks.length > 0) {
				reusedChunks.push(...oldChunks);
				fileMtimes[fp] = prevMtimes[fp];
			}
		}
	}
	void effectiveDepth; // used for logging/future metrics

	// 合并：新增/变更文件的 chunks + 复用的旧 chunks
	const mergedChunks = [...allChunks, ...reusedChunks];

	const invertedIndex = new Map<string, string[]>();
	const docFreq = new Map<string, number>();

	for (let i = 0; i < mergedChunks.length; i++) {
		if (i % 100 === 0) {
			await yieldToEventLoop();
		}

		const chunk = mergedChunks[i];
		const seen = new Set<string>();
		for (const token of chunk.tokens) {
			if (!invertedIndex.has(token)) {
				invertedIndex.set(token, []);
			}
			invertedIndex.get(token)?.push(chunk.id);
			if (!seen.has(token)) {
				seen.add(token);
				docFreq.set(token, (docFreq.get(token) || 0) + 1);
			}
		}
	}

	const totalFiles = new Set(mergedChunks.map((c) => c.filePath)).size;

	return {
		chunks: mergedChunks,
		invertedIndex,
		docFreq,
		totalChunks: mergedChunks.length,
		totalFiles,
		indexedAt: Date.now(),
		version: CURRENT_INDEX_VERSION,
		fileMtimes,
	};
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function collectFiles(
	rootDir: string,
	skipDirs: string[],
	extensions: string[],
	maxDepth: number,
	maxFiles: number,
): string[] {
	const results: string[] = [];
	const rootDepth = rootDir.split(path.sep).filter(Boolean).length;

	function walk(dir: string, depth: number) {
		if (results.length >= maxFiles) return;
		if (depth > maxDepth) return;
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (results.length >= maxFiles) return;
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (!skipDirs.includes(entry.name) && !entry.name.startsWith(".")) {
						walk(fullPath, depth + 1);
					}
				} else if (entry.isFile()) {
					const ext = path.extname(entry.name).toLowerCase();
					if (extensions.includes(ext)) {
						results.push(fullPath);
					}
				}
			}
		} catch {
			// skip unreadable directories
		}
	}

	walk(rootDir, rootDepth);
	return results;
}

export function saveIndex(index: CodeIndex, filePath: string): void {
	const data = {
		chunks: index.chunks,
		invertedIndex: Object.fromEntries(index.invertedIndex),
		docFreq: Object.fromEntries(index.docFreq),
		totalChunks: index.totalChunks,
		totalFiles: index.totalFiles,
		indexedAt: index.indexedAt,
		version: index.version,
		fileMtimes: index.fileMtimes,
		workDir: index.workDir,
	};
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

export function loadIndex(filePath: string): CodeIndex | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw);
		return {
			chunks: data.chunks,
			invertedIndex: new Map(Object.entries(data.invertedIndex || {})),
			docFreq: new Map(Object.entries(data.docFreq || {})),
			totalChunks: data.totalChunks,
			totalFiles: data.totalFiles,
			indexedAt: data.indexedAt,
			version: data.version,
			fileMtimes: data.fileMtimes,
			workDir: data.workDir,
		};
	} catch {
		return null;
	}
}
