import os from "node:os";
import path from "node:path";
import { repoSlug } from "./repoSlug";

/**
 * 集中式 .xuancode 路径解析。
 *
 * 数据三类归属：
 * - 跟用户走   → ~/.xuancode          （偏好、记忆索引、凭据；本地和云端模式都在本地）
 * - 跟项目走   → <workDir>/.xuancode  （会话、检查点、会话记忆；本地=项目根，云端=实例上）
 * - 跟服务走   → 服务数据根           （auth/payments/usage；本地=~/.xuancode/server，云端=实例内）
 *
 * 所有解析器支持环境变量覆盖，用于开发隔离 / 多实例 / 测试注入：
 * - XUANCODE_HOME            用户级根
 * - XUANCODE_PROJECT_DATA    项目级根（部署时默认原地 <workDir>/.xuancode）
 * - XUANCODE_SERVER_DATA     服务级根
 * - XUANCODE_MANAGED_POLICY  L1 组织级策略文件（Windows 本地无 /etc，只能 env 注入）
 */

/** 用户级根目录（原散落三种写法：HOME||USERPROFILE||"~" / os.homedir() / Electron userData） */
export function resolveHome(): string {
	if (process.env.XUANCODE_HOME) return process.env.XUANCODE_HOME;
	return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** 项目级数据根：部署默认原地 <workDir>/.xuancode，开发可用 env 指到仓库外 */
export function resolveProjectData(workDir: string): string {
	if (process.env.XUANCODE_PROJECT_DATA)
		return process.env.XUANCODE_PROJECT_DATA;
	return path.join(workDir, ".xuancode");
}

/** 服务级数据根（daemon/gateway 的 auth、payments、usage、审计日志） */
export function resolveServerData(): string {
	if (process.env.XUANCODE_SERVER_DATA) return process.env.XUANCODE_SERVER_DATA;
	return path.join(resolveHome(), ".xuancode", "server");
}

/** L1 组织级策略文件；读不到由调用方静默跳过（memoryManager 现有 try/catch 兼容） */
export function resolveManagedPolicy(): string {
	if (process.env.XUANCODE_MANAGED_POLICY)
		return process.env.XUANCODE_MANAGED_POLICY;
	return path.join("/etc", "xuancode", "xuancode.md");
}

/**
 * L5 auto_memory 分域目录：
 * - 无 projectDir / 解析不出 slug → ~/.xuancode/memory/global/
 * - 有项目 → ~/.xuancode/memory/projects/<repo-slug>/
 */
export function resolveMemoryScopeDir(projectDir?: string): string {
	const memoryRoot = path.join(resolveHome(), ".xuancode", "memory");
	if (!projectDir) return path.join(memoryRoot, "global");
	const slug = repoSlug(projectDir);
	return path.join(memoryRoot, "projects", slug);
}
