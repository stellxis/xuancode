export { ToolManager } from "./toolManager";
export { readFile, writeFile } from "./fileTool";
export { editFile } from "./editTool";
export { listDir } from "./dirTool";
export { runShell } from "./shellTool";
export { globFiles } from "./globTool";
export { grepFiles } from "./grepTool";
export { webSearch, webFetch } from "./webTool";
export {
	gitStatus,
	gitDiff,
	gitLog,
	gitBranch,
	gitCommit,
	gitPush,
} from "./gitTool";
export { MCPClient, StdioTransport, HttpTransport } from "./mcpClient";
export type {
	MCPToolDefinition,
	MCPCallResult,
	MCPTransport,
} from "./mcpClient";
export { initIgnore, isIgnoreFile } from "./ignore";
export { SHELL_DANGER_LIST, ALLOW_FILE_EXT } from "./constants";
export {
	semanticSearch,
	setSearchProvider,
	clearSearchProvider,
	SEMANTIC_SEARCH_DEF,
} from "./semanticSearchTool";

// ===== Phase 3: 排他锁 & 冲突检测 =====
export {
	LockManager,
	getGlobalLockManager,
	resetGlobalLockManager,
} from "./lockManager";
export {
	detectConflicts,
	collectModifiedFiles,
	formatConflictReport,
} from "./conflictDetector";
export type { ConflictReport } from "./conflictDetector";
