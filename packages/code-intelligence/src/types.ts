/** HTTP 请求调用点（fetch/axios/http 等），用于接口调用链路追踪 */
export interface HttpCallInfo {
	/** 调用表达式，如 fetch / axios.get / http.request */
	callee: string;
	/** HTTP 方法（大写），无法判定时为 GET */
	method: string;
	/** 静态可解析的 URL；动态拼接时为 null */
	url: string | null;
	/** 行号（0-based） */
	line: number;
}

export interface CodeChunk {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	type: "file" | "function" | "class" | "method" | "interface" | "type";
	name: string;
	content: string;
	tokens: string[];
	imports: string[];
	/** 仅文件级 chunk 携带：文件内的 HTTP 调用点 */
	httpCalls?: HttpCallInfo[];
}

export interface CodeIndex {
	chunks: CodeChunk[];
	invertedIndex: Map<string, string[]>;
	docFreq: Map<string, number>;
	totalChunks: number;
	totalFiles: number;
	indexedAt: number;
	version: string;
	/** 文件路径 -> mtime (ms)，用于增量索引 */
	fileMtimes?: Record<string, number>;
	/** 索引对应的 workDir，用于验证缓存是否匹配 */
	workDir?: string;
}

export interface SearchResult {
	chunk: CodeChunk;
	score: number;
	matchType: "keyword" | "embedding";
	matchedTokens: string[];
}

export interface DependencyGraph {
	nodes: { path: string; type: "file" | "directory" }[];
	edges: { from: string; to: string; type: "import" | "re-export" }[];
}

export interface LintResult {
	filePath: string;
	line: number;
	column: number;
	severity: "error" | "warning";
	message: string;
	rule?: string;
}

/**
 * 索引结构版本号。
 * 每当 CodeChunk/解析器新增字段（如 httpCalls）时递增，
 * 加载旧版本缓存时直接丢弃并重建，避免字段缺失。
 */
export const CURRENT_INDEX_VERSION = "1.1.0";

export interface IndexOptions {
	skipDirs?: string[];
	extensions?: string[];
	onProgress?: (processed: number, total: number, currentFile: string) => void;
	/** 上一次索引（用于增量更新，仅重新解析 mtime 变化的文件） */
	previousIndex?: CodeIndex | null;
	/** 最大索引文件数（超出则只取前 N 个） */
	maxFiles?: number;
	/** 目录遍历最大深度（超过则停止下钻） */
	maxDepth?: number;
	/** 索引总超时（毫秒），超时后以已完成的 chunks 作为最终结果 */
	timeoutMs?: number;
}

/** 性能保护默认值 */
export const INDEX_PERF_DEFAULTS = {
	maxFiles: 3000,
	maxDepth: 10,
	timeoutMs: 45_000,
	/** 大仓库自动降级阈值：超过此文件数则自动缩小 maxDepth */
	degradeFileThreshold: 1500,
	degradeDepth: 5,
} as const;

export const DEFAULT_SKIP_DIRS = [
	"node_modules",
	".git",
	"dist",
	"build",
	"target",
	".next",
	".nuxt",
	"coverage",
];

export const SUPPORTED_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".go",
	".rs",
	".java",
	".c",
	".cpp",
	".h",
	".hpp",
	".css",
	".scss",
	".json",
	".yaml",
	".yml",
	".md",
];

export const LANGUAGE_MAP: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	py: "python",
	go: "go",
	rs: "rust",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	css: "css",
	scss: "scss",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	md: "markdown",
};
