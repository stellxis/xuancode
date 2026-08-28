/**
 * 项目级 checkpoint — 长任务的项目状态记忆
 *
 * 上下文压缩和续跑会丢失「改到哪了」的对话细节，本项目状态在内存中持续累积：
 * - 已读取/已修改的文件（去重）
 * - 验证状态（是否跑过、是否通过、失败次数、最近输出）
 * - 已用轮数
 * - 工作流计划快照（步骤 + 完成情况）— 续跑重点记忆
 * - 关键节点时间线（里程碑）
 *
 * 通过 summary() 生成一段稳定摘要，注入到压缩后 / 续跑时的对话里；
 * toContextBlock() 生成更丰富的续跑记忆块（含计划表格与关键节点）。
 * save() 在任务结束时落盘到 .xuancode/checkpoint.json；fromFile() 在任务启动时
 * 续接已有 checkpoint，让跨任务的项目状态累积而不是每轮清空。
 */
import fs from "node:fs";
import path from "node:path";
import type { Message } from "@xuancode/types";

export interface CheckpointVerifyState {
	ran: boolean;
	passed: boolean;
	rounds: number;
	lastCommand?: string;
	lastOutput?: string;
	updatedAt?: number;
}

/** 计划步骤快照（续跑时还原计划表格） */
export interface CheckpointPlanStep {
	id: string;
	label: string;
	status: string;
	subAgentType?: string;
}

export interface ProjectCheckpointSnapshot {
	updatedAt: number;
	filesRead: string[];
	filesWritten: string[];
	verify: CheckpointVerifyState;
	turnsUsed: number;
	/** 工作流计划快照：summary + 步骤完成情况 */
	plan: {
		summary?: string;
		steps: CheckpointPlanStep[];
		completed: number;
		total: number;
	} | null;
	/** 关键节点时间线（里程碑，最新在后） */
	milestones: string[];
}

/** 计划步骤 → 状态图标 */
function stepIcon(status: string): string {
	switch (status) {
		case "completed":
			return "[✓]";
		case "running":
			return "[▶]";
		case "failed":
			return "[✗]";
		case "skipped":
			return "[→]";
		default:
			return "[ ]";
	}
}

/**
 * 把 checkpoint 快照格式化为续跑记忆块（不含 `[项目状态]` 标签，由调用方组装）。
 * 优先级：文件/验证 → 计划完成情况表格 → 关键节点。
 */
export function formatCheckpointSnapshot(
	snap: ProjectCheckpointSnapshot,
): string {
	const lines: string[] = [];

	if (snap.filesWritten.length > 0) {
		const list = snap.filesWritten.slice(0, 10).join(", ");
		lines.push(
			`已修改 ${snap.filesWritten.length} 个文件: ${list}${snap.filesWritten.length > 10 ? " 等" : ""}`,
		);
	}
	if (snap.filesRead.length > 0) {
		lines.push(`已读取 ${snap.filesRead.length} 个文件`);
	}
	if (snap.verify.ran) {
		const st = snap.verify.passed
			? "通过"
			: `失败(已尝试 ${snap.verify.rounds} 次)`;
		lines.push(
			`验证: ${st}${snap.verify.lastCommand ? ` [${snap.verify.lastCommand}]` : ""}`,
		);
	} else if (snap.filesWritten.length > 0) {
		lines.push("验证: 尚未执行");
	}

	const plan = snap.plan;
	if (plan && plan.steps.length > 0) {
		lines.push(
			`计划: ${plan.summary || ""}（${plan.completed}/${plan.total} 步完成）`,
		);
		for (const s of plan.steps) {
			lines.push(
				`${stepIcon(s.status)} ${s.id}: ${s.label}${s.subAgentType ? ` (${s.subAgentType})` : ""}`,
			);
		}
	}

	if (snap.milestones && snap.milestones.length > 0) {
		lines.push(`关键节点: ${snap.milestones.join(" → ")}`);
	}

	return lines.join("\n");
}

/** 从 workDir/.xuancode/checkpoint.json 读取续跑记忆块（不含标签，不存在/损坏返回空串） */
export function loadCheckpointContext(workDir: string): string {
	try {
		const file = path.join(workDir, ".xuancode", "checkpoint.json");
		if (!fs.existsSync(file)) return "";
		const snap = JSON.parse(
			fs.readFileSync(file, "utf-8"),
		) as ProjectCheckpointSnapshot;
		return formatCheckpointSnapshot(snap);
	} catch {
		return "";
	}
}

/** 断点续跑快照 — 每轮持久化，供 daemon 崩溃重启后续跑。按 resumeId（=taskId）区分，避免同 workDir 多任务互相覆盖。 */
export interface ResumeState {
	version: number;
	messages: Message[];
	turnCount: number;
	stopReason?: string;
	updatedAt: number;
}

function resumeFilePath(workDir: string, resumeId: string): string {
	return path.join(workDir, ".xuancode", `resume-${resumeId}.json`);
}

/** 写入断点快照（非致命，失败静默） */
export function writeResumeState(
	workDir: string,
	resumeId: string,
	state: ResumeState,
): void {
	try {
		const dir = path.join(workDir, ".xuancode");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(resumeFilePath(workDir, resumeId), JSON.stringify(state));
	} catch {
		/* resume 持久化失败不影响任务 */
	}
}

/** 读取断点快照；不存在或损坏返回 null */
export function readResumeState(
	workDir: string,
	resumeId: string,
): ResumeState | null {
	try {
		const file = resumeFilePath(workDir, resumeId);
		if (!fs.existsSync(file)) return null;
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as ResumeState;
		if (!Array.isArray(parsed.messages) || typeof parsed.turnCount !== "number")
			return null;
		return parsed;
	} catch {
		return null;
	}
}

/** 清除断点快照（任务完成/取消后调用，幂等） */
export function clearResumeState(workDir: string, resumeId: string): void {
	try {
		const file = resumeFilePath(workDir, resumeId);
		if (fs.existsSync(file)) fs.unlinkSync(file);
	} catch {
		/* ignore */
	}
}

export class ProjectCheckpoint {
	private filesRead = new Set<string>();
	private filesWritten = new Set<string>();
	private verify: CheckpointVerifyState = {
		ran: false,
		passed: false,
		rounds: 0,
	};
	private turnsUsed = 0;
	private plan: ProjectCheckpointSnapshot["plan"] = null;
	private milestones: string[] = [];

	recordRead(p: string): void {
		if (p) this.filesRead.add(String(p));
	}

	recordWrite(p: string): void {
		if (p) this.filesWritten.add(String(p));
	}

	recordVerify(v: Partial<CheckpointVerifyState>): void {
		this.verify = { ...this.verify, ...v, updatedAt: Date.now() };
	}

	setTurns(n: number): void {
		this.turnsUsed = n;
	}

	/** 记录工作流计划快照（含每步状态与完成数） */
	recordPlan(
		plan:
			| {
					summary?: string;
					steps: Array<{
						id: string;
						label: string;
						status: string;
						subAgentType?: string;
					}>;
			  }
			| null
			| undefined,
	): void {
		if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return;
		const total = plan.steps.length;
		const completed = plan.steps.filter(
			(s) =>
				s.status === "completed" ||
				s.status === "failed" ||
				s.status === "skipped",
		).length;
		this.plan = {
			summary: plan.summary,
			steps: plan.steps.map((s) => ({
				id: s.id,
				label: s.label,
				status: s.status,
				subAgentType: s.subAgentType,
			})),
			completed,
			total,
		};
		if (completed === total) {
			this.recordMilestone("工作流计划完成");
		}
	}

	/** 记录关键节点（最新在后，最多保留 20 条） */
	recordMilestone(text: string): void {
		if (!text) return;
		if (this.milestones[this.milestones.length - 1] === text) return;
		this.milestones.push(text);
		if (this.milestones.length > 20) this.milestones.shift();
	}

	get modifiedCount(): number {
		return this.filesWritten.size;
	}

	get verifyState(): CheckpointVerifyState {
		return this.verify;
	}

	get milestoneCount(): number {
		return this.milestones.length;
	}

	/** 项目状态摘要 — 注入给模型的稳定记忆。无实质进展时返回空串 */
	summary(): string {
		const parts: string[] = [];
		if (this.filesWritten.size > 0) {
			const list = [...this.filesWritten];
			const shown = list.slice(0, 10).join(", ");
			parts.push(
				`已修改 ${list.length} 个文件: ${shown}${list.length > 10 ? " 等" : ""}`,
			);
		}
		if (this.filesRead.size > 0) {
			parts.push(`已读取 ${this.filesRead.size} 个文件`);
		}
		if (this.verify.ran) {
			const st = this.verify.passed
				? "通过"
				: `失败(已尝试 ${this.verify.rounds} 次)`;
			parts.push(
				`验证: ${st}${this.verify.lastCommand ? ` [${this.verify.lastCommand}]` : ""}`,
			);
		} else if (this.filesWritten.size > 0) {
			parts.push("验证: 尚未执行");
		}
		if (this.plan && this.plan.total > 0) {
			parts.push(`计划进度: ${this.plan.completed}/${this.plan.total}`);
		}
		return parts.length > 0 ? `[项目状态] ${parts.join(" · ")}` : "";
	}

	/** 续跑重点记忆块：文件/验证 + 计划表格 + 关键节点（含标签） */
	toContextBlock(): string {
		const body = formatCheckpointSnapshot(this.snapshot());
		return body ? `[项目状态]\n${body}` : "";
	}

	/** 合并已有快照，实现跨任务状态累积（文件取并集、验证取最新、计划替换、里程碑追加） */
	seed(snap: Partial<ProjectCheckpointSnapshot>): void {
		if (snap.filesRead) for (const f of snap.filesRead) this.filesRead.add(f);
		if (snap.filesWritten)
			for (const f of snap.filesWritten) this.filesWritten.add(f);
		if (snap.verify) this.verify = { ...this.verify, ...snap.verify };
		if (snap.turnsUsed) this.turnsUsed = snap.turnsUsed;
		if (snap.plan) this.plan = snap.plan;
		if (snap.milestones) this.milestones = [...snap.milestones];
	}

	snapshot(): ProjectCheckpointSnapshot {
		return {
			updatedAt: Date.now(),
			filesRead: [...this.filesRead],
			filesWritten: [...this.filesWritten],
			verify: this.verify,
			turnsUsed: this.turnsUsed,
			plan: this.plan,
			milestones: [...this.milestones],
		};
	}

	/** 从已有 checkpoint 续接（跨任务累积项目状态）；不存在则返回空白实例 */
	static fromFile(workDir: string): ProjectCheckpoint {
		const cp = new ProjectCheckpoint();
		try {
			const file = path.join(workDir, ".xuancode", "checkpoint.json");
			if (fs.existsSync(file)) {
				const snap = JSON.parse(
					fs.readFileSync(file, "utf-8"),
				) as ProjectCheckpointSnapshot;
				cp.seed(snap);
			}
		} catch {
			/* 损坏的 checkpoint 忽略，从头开始 */
		}
		return cp;
	}

	/** 落盘到 workDir/.xuancode/checkpoint.json（非致命，失败静默） */
	save(workDir: string): void {
		try {
			const dir = path.join(workDir, ".xuancode");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, "checkpoint.json"),
				JSON.stringify(this.snapshot(), null, 2),
			);
		} catch {
			/* checkpoint 持久化失败不影响任务 */
		}
	}
}
