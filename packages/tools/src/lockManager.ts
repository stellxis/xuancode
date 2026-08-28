/**
 * 写操作排他锁 — 防止多个 Agent 同时写入同一文件
 *
 * 功能:
 * - 按文件路径加锁（粒度: 文件级）
 * - 支持锁持有者标识（agent/task ID）
 * - 可配置等待超时
 * - 支持强制解锁（管理员/超时场景）
 */
import fs from "node:fs";
import path from "node:path";

interface LockEntry {
	filePath: string;
	holderId: string;
	holderLabel: string;
	acquiredAt: number;
	expiresAt: number;
}

export class LockManager {
	private locks = new Map<string, LockEntry>();
	private snapshots = new Map<string, string>(); // filePath -> content snapshot before write
	private defaultTimeoutMs = 30_000; // 30s
	private lockTtlMs = 120_000; // 2min max hold time

	/**
	 * 尝试获取写锁
	 * @returns true 获取成功，false 文件已被其他持有者锁定
	 */
	acquireLock(
		filePath: string,
		holderId: string,
		holderLabel?: string,
		timeoutMs?: number,
	): boolean {
		const resolvedPath = path.resolve(filePath);
		const existing = this.locks.get(resolvedPath);

		// 清理过期锁
		if (existing && Date.now() > existing.expiresAt) {
			this.locks.delete(resolvedPath);
		}

		// 已被其他持有者锁定
		if (existing && existing.holderId !== holderId) {
			return false;
		}

		// 同一持有者重新获取 — 刷新过期时间
		const timeout = timeoutMs || this.defaultTimeoutMs;
		const entry: LockEntry = {
			filePath: resolvedPath,
			holderId,
			holderLabel: holderLabel || holderId,
			acquiredAt: Date.now(),
			expiresAt: Date.now() + Math.max(timeout, this.lockTtlMs),
		};

		// 首次锁定此文件时拍摄快照
		if (!existing) {
			this.snapshotFile(resolvedPath);
		}

		this.locks.set(resolvedPath, entry);
		return true;
	}

	/** 释放写锁 */
	releaseLock(filePath: string, holderId: string): boolean {
		const resolvedPath = path.resolve(filePath);
		const entry = this.locks.get(resolvedPath);
		if (!entry) return true; // 没有锁也算成功
		if (entry.holderId !== holderId) return false; // 不是自己的锁不能释放
		this.locks.delete(resolvedPath);
		return true;
	}

	/** 释放指定持有者的所有锁 */
	releaseAllLocks(holderId: string): string[] {
		const released: string[] = [];
		for (const [filePath, entry] of this.locks) {
			if (entry.holderId === holderId) {
				this.locks.delete(filePath);
				released.push(filePath);
			}
		}
		return released;
	}

	/** 强制解锁（管理员用） */
	forceRelease(filePath: string): void {
		this.locks.delete(path.resolve(filePath));
	}

	/** 检查文件是否被锁定 */
	isLocked(filePath: string): boolean {
		const entry = this.locks.get(path.resolve(filePath));
		if (!entry) return false;
		if (Date.now() > entry.expiresAt) {
			this.locks.delete(path.resolve(filePath));
			return false;
		}
		return true;
	}

	/** 获取锁的持有者信息 */
	getLockHolder(
		filePath: string,
	): { holderId: string; holderLabel: string } | null {
		const entry = this.locks.get(path.resolve(filePath));
		if (!entry || Date.now() > entry.expiresAt) return null;
		return { holderId: entry.holderId, holderLabel: entry.holderLabel };
	}

	/** 获取 lock manager 快照（调试用） */
	getLockSnapshot(): Array<{
		filePath: string;
		holderLabel: string;
		remainingMs: number;
	}> {
		const now = Date.now();
		return Array.from(this.locks.values())
			.filter((e) => now < e.expiresAt)
			.map((e) => ({
				filePath: e.filePath,
				holderLabel: e.holderLabel,
				remainingMs: e.expiresAt - now,
			}));
	}

	/** 获取所有被锁定的文件路径 */
	getLockedFiles(): string[] {
		return Array.from(this.locks.keys());
	}

	/** 获取文件快照 */
	getSnapshot(filePath: string): string | undefined {
		return this.snapshots.get(path.resolve(filePath));
	}

	/** 获取所有快照 */
	getAllSnapshots(): Map<string, string> {
		return new Map(this.snapshots);
	}

	/** 清除快照 */
	clearSnapshots(): void {
		this.snapshots.clear();
	}

	/** 拍摄文件快照 */
	private snapshotFile(resolvedPath: string): void {
		try {
			if (fs.existsSync(resolvedPath)) {
				this.snapshots.set(
					resolvedPath,
					fs.readFileSync(resolvedPath, "utf-8"),
				);
			}
		} catch {
			// 文件可能不存在（新建文件），跳过快照
		}
	}
}

/** 全局单例 */
let globalLockManager: LockManager | null = null;

export function getGlobalLockManager(): LockManager {
	if (!globalLockManager) {
		globalLockManager = new LockManager();
	}
	return globalLockManager;
}

export function resetGlobalLockManager(): void {
	globalLockManager = null;
}
