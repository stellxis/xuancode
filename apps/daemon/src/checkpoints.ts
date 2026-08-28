import { execFileSync } from "node:child_process";
import fs from "node:fs";
/**
 * C1 · Git 检查点 — 每次用户下发新指令前自动提交当前工作区状态，
 * 提供清单/差异/回滚能力（渲染端「回滚」入口 + diff 审查面）。
 * 仅本地仓库操作，绝不 push；回滚前自动生成备份提交，可逆。
 * `.xuancode` 目录一律排除在检查点之外（会话库/快照是运行时产物，不进代码提交）。
 */
import path from "node:path";

export interface CheckpointMeta {
	hash: string;
	message: string;
	userInput: string;
	createdAt: string;
	filesChanged: number;
}

const MAX_CHECKPOINTS = 10;
const CHECKPOINT_PREFIX = "[玄码检查点]";

function manifestPath(workDir: string): string {
	return path.join(workDir, ".xuancode", "checkpoints.json");
}

function convPath(workDir: string, hash: string): string {
	return path.join(workDir, ".xuancode", `conv-${hash}.json`);
}

function readManifest(workDir: string): CheckpointMeta[] {
	try {
		const raw = fs.readFileSync(manifestPath(workDir), "utf-8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : [];
	} catch {
		return [];
	}
}

function writeManifest(workDir: string, entries: CheckpointMeta[]): void {
	const dir = path.dirname(manifestPath(workDir));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		manifestPath(workDir),
		JSON.stringify({ checkpoints: entries }, null, 2),
		"utf-8",
	);
}

function git(args: string[], cwd: string): { out: string; err: string } {
	try {
		return {
			out: execFileSync("git", args, {
				cwd,
				encoding: "utf-8",
				maxBuffer: 10 * 1024 * 1024,
			}).trim(),
			err: "",
		};
	} catch (e: any) {
		return { out: "", err: String(e?.stderr || e?.message || e).trim() };
	}
}

/** 是否 git 仓库 + 当前是否有非 .xuancode 的未提交更改 */
function repoHasChanges(workDir: string): boolean {
	if (git(["rev-parse", "--git-dir"], workDir).err) return false;
	const st = git(["status", "--porcelain"], workDir);
	return st.out.split("\n").some((l) => l.trim() && !l.includes(".xuancode"));
}

/** 创建检查点提交。非仓库 / 干净树 → created:false（不产生空提交噪音）。 */
export async function createCheckpoint(
	workDir: string,
	opts?: { input?: string; messages?: unknown[] },
): Promise<{ created: boolean; hash?: string; reason?: string }> {
	try {
		if (!repoHasChanges(workDir)) {
			return { created: false, reason: "clean" };
		}
		const now = new Date();
		const ts = now
			.toLocaleString("zh-CN", {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			})
			.replace(/\//g, "-");
		const inputBrief = (opts?.input || "").replace(/\s+/g, " ").slice(0, 40);
		const message = `${CHECKPOINT_PREFIX} ${ts}${inputBrief ? ` — ${inputBrief}` : ""}`;

		// 只暂存非 .xuancode 的更改，避免运行时产物污染检查点
		const add = git(["add", "-A", "--", ":(exclude).xuancode"], workDir);
		if (add.err.toLowerCase().includes("fatal"))
			return { created: false, reason: add.err };
		const commit = git(["commit", "-m", message], workDir);
		if (commit.err.toLowerCase().includes("fatal"))
			return { created: false, reason: commit.err };

		const hash = git(["rev-parse", "HEAD"], workDir).out;
		if (!hash) return { created: false, reason: "no-hash" };

		const filesChanged = git(["show", "--numstat", "--format=", hash], workDir)
			.out.split("\n")
			.filter((l) => l.trim()).length;

		const entries = readManifest(workDir)
			.filter((e) => e.hash !== hash)
			.concat([
				{
					hash,
					message,
					userInput: opts?.input || "",
					createdAt: new Date().toISOString(),
					filesChanged,
				},
			])
			.slice(-MAX_CHECKPOINTS);
		writeManifest(workDir, entries);

		if (opts?.messages?.length)
			saveConversationSnapshot(workDir, hash, opts.messages);

		return { created: true, hash };
	} catch (err: any) {
		return { created: false, reason: String(err?.message || err) };
	}
}

export function listCheckpoints(workDir: string): CheckpointMeta[] {
	return readManifest(workDir).slice().reverse();
}

/**
 * git log 中带 [玄码检查点] 前缀的提交（可能由并行玄码实例创建，未写入本机 manifest）。
 * 与 manifest 检查点按 hash 合并后，保证任务页「Git 检查点」能显示所有检查点提交。
 */
function gitCheckpointCommits(workDir: string): CheckpointMeta[] {
	if (git(["rev-parse", "--git-dir"], workDir).err) return [];
	const log = git(["log", "-n", "50", "--format=%H%x1f%s%x1f%at"], workDir);
	if (log.err) return [];
	const out: CheckpointMeta[] = [];
	for (const line of log.out.split("\n")) {
		if (!line) continue;
		const [hash, subject, epoch] = line.split("\x1f");
		if (!hash || !subject?.startsWith(CHECKPOINT_PREFIX)) continue;
		const filesChanged = git(["show", "--numstat", "--format=", hash], workDir)
			.out.split("\n")
			.filter((l) => l.trim()).length;
		// 去掉前缀与 "MM-DD HH:MM —" 时间戳，剩余作为 userInput 展示
		const brief = subject
			.slice(CHECKPOINT_PREFIX.length)
			.replace(/^\s*\d{2}-\d{2}\s+\d{2}:\d{2}\s*/u, "")
			.replace(/^[—–-]?\s*/u, "")
			.trim();
		out.push({
			hash,
			message: subject,
			userInput: brief,
			createdAt: new Date(Number.parseInt(epoch, 10) * 1000).toISOString(),
			filesChanged,
		});
	}
	return out;
}

/** manifest + git log 检查点合并（按 hash 去重，按时间倒序）。 */
export function listCheckpointsMerged(workDir: string): CheckpointMeta[] {
	const byHash = new Map<string, CheckpointMeta>();
	for (const c of listCheckpoints(workDir)) byHash.set(c.hash, c);
	for (const c of gitCheckpointCommits(workDir)) {
		if (!byHash.has(c.hash)) byHash.set(c.hash, c);
	}
	return [...byHash.values()].sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
}

/** 差异审查面：该检查点→当前工作区改了什么（= 回滚将丢弃的内容）。 */
export async function checkpointDiff(
	workDir: string,
	hash: string,
): Promise<{ success: boolean; data: string; error?: string }> {
	const stat = git(["diff", "--stat", hash], workDir);
	if (stat.err.toLowerCase().includes("fatal")) {
		return { success: false, data: "", error: stat.err };
	}
	const body = git(["diff", hash, "--", ".", ":(exclude).xuancode"], workDir);
	const statText = stat.out || "无差异";
	const bodyText = body.err
		? ""
		: body.out.length > 8000
			? `${body.out.slice(0, 8000)}\n\n... (已截断, 共 ${body.out.length} 字符)`
			: body.out;
	return {
		success: true,
		data: bodyText ? `${statText}\n\n${bodyText}` : statText,
	};
}

/**
 * 回滚到检查点（还原代码）。默认先创建「回滚前备份」提交保证可逆，
 * 再 git reset --hard <hash>。untracked 文件不受影响（reset 仅动已跟踪文件）。
 */
export async function rollbackCheckpoint(
	workDir: string,
	hash: string,
	opts?: { backup?: boolean },
): Promise<{ ok: boolean; message: string; backupHash?: string }> {
	const exists = git(["cat-file", "-e", `${hash}^{commit}`], workDir);
	if (exists.err.includes("fatal")) {
		return { ok: false, message: `检查点不存在: ${hash.slice(0, 12)}` };
	}

	let backupHash: string | undefined;
	if (opts?.backup !== false) {
		const backup = git(
			[
				"commit",
				"-am",
				`${CHECKPOINT_PREFIX} 回滚前备份 ${new Date().toLocaleString("zh-CN")}`,
			],
			workDir,
		);
		// 干净树时 commit 失败是正常的（无可备份）；成功后以 HEAD 回填备份哈希
		const nothingToCommit = /nothing to commit|无任何改动|没有要提交/.test(
			backup.err,
		);
		if (!nothingToCommit && !backup.err.toLowerCase().includes("fatal")) {
			backupHash = git(["rev-parse", "HEAD"], workDir).out || undefined;
		}
	}

	const reset = git(["reset", "--hard", hash], workDir);
	if (reset.err.toLowerCase().includes("fatal")) {
		return { ok: false, message: `回滚失败: ${reset.err}` };
	}

	return {
		ok: true,
		message: `已回滚到 ${hash.slice(0, 12)}${backupHash ? `（备份 ${backupHash.slice(0, 8)}）` : ""}`,
		backupHash,
	};
}

/** 会话快照：检查点创建时的对话消息（用于「还原对话」）。 */
export function saveConversationSnapshot(
	workDir: string,
	hash: string,
	messages: unknown[],
): void {
	try {
		const dir = path.dirname(convPath(workDir, hash));
		fs.mkdirSync(dir, { recursive: true });
		const slim = messages.slice(-40).map((m: any) => ({
			role: m?.role,
			content: String(m?.content || "").slice(0, 2000),
			...(m?.toolCalls ? { toolCalls: m.toolCalls } : {}),
		}));
		fs.writeFileSync(
			convPath(workDir, hash),
			JSON.stringify({ messages: slim }, null, 2),
			"utf-8",
		);
	} catch {
		/* 快照失败不阻塞 */
	}
}

export function readConversationSnapshot(
	workDir: string,
	hash: string,
): unknown[] {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(convPath(workDir, hash), "utf-8"),
		);
		return Array.isArray(parsed?.messages) ? parsed.messages : [];
	} catch {
		return [];
	}
}
