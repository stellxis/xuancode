import fs from "node:fs/promises";
import path from "node:path";
import { resolveHome, resolveProjectData, resolveServerData } from "./paths";

/**
 * 旧布局 → 新布局的幂等迁移。
 *
 * 原则：
 * - 只前向不回退；全部单文件粒度 try/catch，失败不阻塞启动（读侧保留双兼容）
 * - copy/rename 优先，delete 延后到 GC 阶段
 * - 迁移标记写在数据根内（不写在代码目录），镜像重建不会重复搬家
 *
 * 调用时机：三端入口（daemon / cli / desktop main）启动早期显式调用。
 */

const MARKER = ".migrated-v2";

async function isMarked(root: string): Promise<boolean> {
	try {
		await fs.access(path.join(root, MARKER));
		return true;
	} catch {
		return false;
	}
}

async function mark(root: string): Promise<void> {
	try {
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(
			path.join(root, MARKER),
			new Date().toISOString(),
			"utf-8",
		);
	} catch {
		// 标记失败不影响主流程（下次启动重跑迁移，幂等）
	}
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/** 安全改名：目标不存在才执行（幂等） */
async function renameIfAbsent(from: string, to: string): Promise<boolean> {
	try {
		if (!(await exists(from))) return false;
		if (await exists(to)) return false;
		await fs.mkdir(path.dirname(to), { recursive: true });
		await fs.rename(from, to);
		return true;
	} catch (e) {
		console.error("[migrate] rename failed:", from, "->", to, e);
		return false;
	}
}

/** 安全复制文件：目标不存在才执行（幂等） */
async function copyIfAbsent(from: string, to: string): Promise<boolean> {
	try {
		if (!(await exists(from))) return false;
		if (await exists(to)) return false;
		await fs.mkdir(path.dirname(to), { recursive: true });
		await fs.copyFile(from, to);
		return true;
	} catch (e) {
		console.error("[migrate] copy failed:", from, "->", to, e);
		return false;
	}
}

/**
 * 用户级 ~/.xuancode 迁移。
 *
 * 记忆双格式（MEMORY.json / session-learnings.json）由 MemoryStore.load() 与
 * SessionDistiller 惰性迁移（载入即改名 .bak），此处只建目录与标记。
 * code-index-<hash>.json 无法从 hash 反查项目路径，不迁移（属可重建缓存），
 * 留待 GC 按过期时间清理。
 */
export async function migrateHomeDir(home = resolveHome()): Promise<void> {
	const root = path.join(home, ".xuancode");
	if (await isMarked(root)) return;

	try {
		await fs.mkdir(path.join(root, "memory"), { recursive: true });
		await fs.mkdir(path.join(root, "cache", "code-index"), { recursive: true });
	} catch (e) {
		console.error("[migrate] migrateHomeDir mkdir failed:", e);
	}
	await mark(root);
}

/**
 * 项目级 <workDir>/.xuancode 迁移：
 * - 平铺 sessions/<id>.jsonl → sessions/<id>/transcript.jsonl
 * - session-memory.md / subagent-memory.md → 最新会话目录（copy 保留原文件，
 *   多会话可能引用）
 * - hooks.log / session.log / events.jsonl 轮转文件 → logs/
 */
export async function migrateProjectData(workDir: string): Promise<void> {
	const root = resolveProjectData(workDir);
	if (await isMarked(root)) return;

	try {
		// 1. 平铺会话 jsonl → 会话目录
		const sessionsDir = path.join(root, "sessions");
		let entries: string[] = [];
		try {
			entries = (await fs.readdir(sessionsDir)).filter(
				(f) => f.endsWith(".jsonl") && !f.startsWith("."),
			);
		} catch {
			/* sessions 目录不存在 */
		}
		for (const f of entries) {
			const sessionId = f.replace(/\.jsonl$/, "");
			await renameIfAbsent(
				path.join(sessionsDir, f),
				path.join(sessionsDir, sessionId, "transcript.jsonl"),
			);
		}

		// 2. L6/L7 会话记忆 → 最新会话目录（copy：原文件保留给旧版本降级读取）
		const sessionDirs = (
			await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => [])
		)
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
		const latestSession = sessionDirs[sessionDirs.length - 1];
		if (latestSession) {
			const latestDir = path.join(sessionsDir, latestSession);
			await copyIfAbsent(
				path.join(root, "session-memory.md"),
				path.join(latestDir, "session-memory.md"),
			);
			await copyIfAbsent(
				path.join(root, "subagent-memory.md"),
				path.join(latestDir, "subagent-memory.md"),
			);
		}

		// 3. 根目录日志 → logs/
		for (const log of ["hooks.log", "session.log"]) {
			await renameIfAbsent(path.join(root, log), path.join(root, "logs", log));
		}
	} catch (e) {
		console.error("[migrate] migrateProjectData failed:", e);
	}
	await mark(root);
}

/**
 * 服务级数据迁移（copy 不 delete）：旧 <cwd>/.xuancode/{auth,payments} → 服务根。
 * 旧目录保留 DEPRECATED 标记，供回滚期旧版本读取，下一版由 GC 清理。
 */
export async function migrateServerData(
	serverDataDir = resolveServerData(),
	legacyDirs: string[] = [path.join(process.cwd(), ".xuancode")],
): Promise<void> {
	if (await isMarked(serverDataDir)) return;

	try {
		for (const legacyRoot of legacyDirs) {
			// plans.json（计费配置）也在旧项目根，一并复制到服务根
			await copyIfAbsent(
				path.join(legacyRoot, "plans.json"),
				path.join(serverDataDir, "plans.json"),
			);
			for (const sub of ["auth", "payments"]) {
				const legacyDir = path.join(legacyRoot, sub);
				if (!(await exists(legacyDir))) continue;
				const files = await fs.readdir(legacyDir).catch(() => [] as string[]);
				for (const f of files) {
					await copyIfAbsent(
						path.join(legacyDir, f),
						path.join(serverDataDir, sub, f),
					);
				}
				// 留弃用标记（不删旧数据，回滚安全）
				try {
					const markerPath = path.join(
						legacyDir,
						"DEPRECATED-moved-to-server-root",
					);
					if (!(await exists(markerPath))) {
						await fs.writeFile(markerPath, new Date().toISOString(), "utf-8");
					}
				} catch {
					/* 标记失败忽略 */
				}
			}
		}
	} catch (e) {
		console.error("[migrate] migrateServerData failed:", e);
	}
	await mark(serverDataDir);
}
