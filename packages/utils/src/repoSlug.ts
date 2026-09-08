import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * 简单字符串哈希（与原 daemon/index.ts 实现一致，用于索引路径隔离）
 */
export function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = (hash << 5) - hash + str.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash).toString(36);
}

/** 文件名安全的 repo slug：小写、非法字符转 -、限 80 字符 */
export function sanitizeRepoSlug(raw: string): string {
	return (
		raw
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "unknown"
	);
}

/** 从 git remote URL 提取 owner/repo（兼容 https / ssh / 短路径） */
function ownerRepoFromRemoteUrl(url: string): string | null {
	const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
	return m ? `${m[1]}__${m[2]}` : null;
}

/**
 * 项目的稳定标识 slug，用于记忆分域等用户级按项目隔离的目录命名：
 * 1. git origin 能解析 → "owner__repo"
 * 2. 失败 → "basename-<simpleHash(absPath) 前 8 位>"
 */
export function repoSlug(workDir: string): string {
	try {
		const url = execFileSync(
			"git",
			["-C", workDir, "remote", "get-url", "origin"],
			{
				encoding: "utf-8",
				timeout: 3000,
				stdio: ["ignore", "pipe", "ignore"],
			},
		).trim();
		const ownerRepo = ownerRepoFromRemoteUrl(url);
		if (ownerRepo) return sanitizeRepoSlug(ownerRepo);
	} catch {
		// 非 git 仓库 / 无 origin / git 不可用 → 走哈希兜底
	}
	const base = path.basename(path.resolve(workDir));
	const hash = simpleHash(path.resolve(workDir)).slice(0, 8);
	return sanitizeRepoSlug(`${base}-${hash}`);
}
