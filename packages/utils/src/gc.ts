import fs from "node:fs/promises";
import path from "node:path";

/**
 * 数据目录 GC。
 *
 * .last-cleanup 标记（对齐 Claude Code）：
 * - 每个数据根一个；距上次清理 > minIntervalMs 才执行（默认 24h）
 * - 清理项全部单条目 try/catch + mtime 白名单校验，失败不阻塞
 *
 * 清理范围：
 * - 用户级根：旧布局残留 code-index-*.json（>7 天）、logs/ 超期轮转文件
 * - 项目级根：logs/ 超期文件、merge-tmp/ 孤儿（>7 天）、无 transcript 的空会话目录
 * - 记忆分域：30 天未访问的孤儿项目 scope（项目目录改名/删除后遗留）
 */

const CLEANUP_MARKER = ".last-cleanup";
const DAY = 86_400_000;

export interface GcOptions {
	/** 两次清理的最小间隔，默认 24h */
	minIntervalMs?: number;
	/** 日志保留天数，默认 14 */
	logRetentionDays?: number;
	/** 缓存/临时文件保留天数，默认 7 */
	cacheRetentionDays?: number;
	/** 孤儿记忆 scope 保留天数，默认 30 */
	orphanScopeRetentionDays?: number;
	/** 当前活跃项目目录列表（用于判断孤儿记忆 scope） */
	activeProjectSlugs?: string[];
	/** 记忆分域根目录（默认 ~/.xuancode/memory） */
	memoryRoot?: string;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function safeUnlink(p: string): Promise<boolean> {
	try {
		await fs.unlink(p);
		return true;
	} catch {
		return false;
	}
}

async function safeRm(p: string): Promise<boolean> {
	try {
		await fs.rm(p, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

async function isOlderThan(p: string, days: number): Promise<boolean> {
	try {
		const stat = await fs.stat(p);
		return Date.now() - stat.mtimeMs > days * DAY;
	} catch {
		return false;
	}
}

/** 清理目录中超过保留期的文件，返回删除数 */
async function pruneOldFiles(dir: string, days: number): Promise<number> {
	let deleted = 0;
	const entries = await fs.readdir(dir).catch(() => [] as string[]);
	for (const f of entries) {
		const p = path.join(dir, f);
		try {
			if ((await fs.stat(p)).isFile() && (await isOlderThan(p, days))) {
				if (await safeUnlink(p)) deleted++;
			}
		} catch {
			/* skip */
		}
	}
	return deleted;
}

/** 删除无 transcript 的空会话目录（中断写入的残留） */
async function pruneOrphanSessionDirs(sessionsDir: string): Promise<number> {
	let deleted = 0;
	const entries = await fs
		.readdir(sessionsDir, { withFileTypes: true })
		.catch(() => []);
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const dir = path.join(sessionsDir, e.name);
		const transcript = await exists(path.join(dir, "transcript.jsonl"));
		const hasFlat = await exists(path.join(sessionsDir, `${e.name}.jsonl`));
		if (!transcript && !hasFlat && (await isOlderThan(dir, 7))) {
			if (await safeRm(dir)) deleted++;
		}
	}
	return deleted;
}

/** scope 是否过期：内部所有文件均超过保留期未修改（空目录按目录 mtime 判断） */
async function isScopeStale(dir: string, days: number): Promise<boolean> {
	let sawAny = false;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		const entries = await fs
			.readdir(current, { withFileTypes: true })
			.catch(() => []);
		for (const e of entries) {
			const p = path.join(current, e.name);
			if (e.isDirectory()) {
				stack.push(p);
			} else {
				sawAny = true;
				if (!(await isOlderThan(p, days))) return false;
			}
		}
	}
	if (!sawAny) return isOlderThan(dir, days);
	return true;
}

/** 清理孤儿记忆 scope（不在活跃项目列表且超过保留期） */
async function pruneOrphanMemoryScopes(
	memoryRoot: string,
	activeSlugs: Set<string>,
	retentionDays: number,
): Promise<number> {
	let deleted = 0;
	const projectsDir = path.join(memoryRoot, "projects");
	const scopes = await fs
		.readdir(projectsDir, { withFileTypes: true })
		.catch(() => []);
	for (const e of scopes) {
		if (!e.isDirectory()) continue;
		if (activeSlugs.has(e.name)) continue;
		const dir = path.join(projectsDir, e.name);
		if (await isScopeStale(dir, retentionDays)) {
			if (await safeRm(dir)) deleted++;
		}
	}
	return deleted;
}

/**
 * 判定是否到期执行（.last-cleanup 超 minIntervalMs），到期则返回并立即刷新标记。
 * 标记刷新在前——即使中途崩溃也不会高频重试。
 */
async function shouldRun(
	root: string,
	minIntervalMs: number,
): Promise<boolean> {
	const marker = path.join(root, CLEANUP_MARKER);
	try {
		const stat = await fs.stat(marker);
		if (Date.now() - stat.mtimeMs < minIntervalMs) return false;
	} catch {
		/* 首次运行 */
	}
	try {
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(marker, new Date().toISOString(), "utf-8");
	} catch {
		/* 标记失败仍执行本次清理 */
	}
	return true;
}

/**
 * 用户级根清理（~/.xuancode）。
 * 旧布局 code-index-<hash>.json 位于根目录平铺（新版已迁至 cache/code-index/），过期即删。
 */
export async function cleanupHomeRoot(
	home = process.env.XUANCODE_HOME ||
		process.env.HOME ||
		process.env.USERPROFILE ||
		"",
	opts: GcOptions = {},
): Promise<number> {
	const root = path.join(home, ".xuancode");
	const minIntervalMs = opts.minIntervalMs ?? DAY;
	if (!(await shouldRun(root, minIntervalMs))) return 0;
	const cacheDays = opts.cacheRetentionDays ?? 7;
	const logDays = opts.logRetentionDays ?? 14;

	let deleted = 0;
	try {
		// 旧布局残留：根目录平铺的 code-index-*.json（新版在 cache/code-index/）
		for (const f of await fs.readdir(root).catch(() => [] as string[])) {
			if (/^code-index(-.+)?\.json$/.test(f)) {
				const p = path.join(root, f);
				if (await isOlderThan(p, cacheDays)) {
					if (await safeUnlink(p)) deleted++;
				}
			}
		}
		deleted += await pruneOldFiles(path.join(root, "logs"), logDays);
		deleted += await pruneOrphanMemoryScopes(
			path.join(root, "memory"),
			new Set(opts.activeProjectSlugs ?? []),
			opts.orphanScopeRetentionDays ?? 30,
		);
	} catch (e) {
		console.error("[gc] cleanupHomeRoot failed:", e);
	}
	return deleted;
}

/** 项目级根清理（<workDir>/.xuancode） */
export async function cleanupProjectRoot(
	projectDataDir: string,
	opts: GcOptions = {},
): Promise<number> {
	const minIntervalMs = opts.minIntervalMs ?? DAY;
	if (!(await shouldRun(projectDataDir, minIntervalMs))) return 0;
	const cacheDays = opts.cacheRetentionDays ?? 7;
	const logDays = opts.logRetentionDays ?? 14;

	let deleted = 0;
	try {
		deleted += await pruneOldFiles(path.join(projectDataDir, "logs"), logDays);
		deleted += await pruneOldFiles(
			path.join(projectDataDir, "merge-tmp"),
			cacheDays,
		);
		deleted += await pruneOrphanSessionDirs(
			path.join(projectDataDir, "sessions"),
		);
	} catch (e) {
		console.error("[gc] cleanupProjectRoot failed:", e);
	}
	return deleted;
}
