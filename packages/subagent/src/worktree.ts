import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectData } from "@xuancode/utils";

/**
 * Worktree Isolation — creates isolated workspaces for sub-agents
 *
 * 3 isolation modes:
 * - worktree: git worktree-based file system isolation
 * - in-process: lightweight context isolation (no git needed)
 * - remote: cross-machine execution (future)
 */

export type IsolationLevel = "none" | "worktree" | "remote" | "in-process";

export interface WorktreeOptions {
	baseDir: string;
	branchName?: string;
	cleanupOnComplete: boolean;
}

export class WorktreeManager {
	private activeWorktrees: Map<string, string> = new Map();

	/**
	 * Create an isolated worktree
	 * Returns the worktree path
	 */
	async create(options: WorktreeOptions): Promise<string> {
		const branchName = options.branchName || `xuancode-wt-${Date.now()}`;
		const worktreeDir = path.join(
			resolveProjectData(options.baseDir),
			"worktrees",
			branchName,
		);
		const worktreePath = worktreeDir;

		// Ensure the worktrees directory exists
		fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

		try {
			// Try git worktree — if it fails, fall back to directory copy
			execSync(
				`git worktree add "${worktreePath}" -b "${branchName}" HEAD 2>/dev/null || ` +
					`mkdir -p "${worktreePath}"`,
				{
					cwd: options.baseDir,
					encoding: "utf-8",
					stdio: "pipe",
					windowsHide: true,
				},
			);
		} catch {
			// Fallback: create empty work directory
			fs.mkdirSync(worktreePath, { recursive: true });
		}

		this.activeWorktrees.set(branchName, worktreePath);
		return worktreePath;
	}

	/**
	 * Remove a worktree
	 */
	async remove(branchName: string): Promise<void> {
		const worktreePath = this.activeWorktrees.get(branchName);
		if (!worktreePath) return;

		try {
			// Try git worktree remove first
			execSync(`git worktree remove "${worktreePath}" 2>/dev/null`, {
				stdio: "pipe",
				windowsHide: true,
			});
		} catch {
			// Fallback: delete directory
			fs.rmSync(worktreePath, { recursive: true, force: true });
		}

		this.activeWorktrees.delete(branchName);
	}

	/**
	 * List active worktrees
	 */
	listActive(): Map<string, string> {
		return new Map(this.activeWorktrees);
	}

	/**
	 * Clean up all worktrees
	 */
	async cleanupAll(): Promise<void> {
		for (const [branch] of this.activeWorktrees) {
			await this.remove(branch);
		}
	}
}
