import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	ProjectCheckpoint,
	clearResumeState,
	loadCheckpointContext,
	readResumeState,
	writeResumeState,
} from "./projectCheckpoint";

const TMP = path.join(process.cwd(), ".test-checkpoint-tmp");

describe("ProjectCheckpoint (B3)", () => {
	beforeAll(() => {
		if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
		fs.mkdirSync(TMP, { recursive: true });
	});

	afterAll(() => {
		fs.rmSync(TMP, { recursive: true, force: true });
	});

	it("B3: seed → save → fromFile 往返保留文件/验证/计划/里程碑", () => {
		const cp = new ProjectCheckpoint();
		cp.recordRead("a.ts");
		cp.recordWrite("b.ts");
		cp.recordWrite("c.ts");
		cp.recordVerify({
			ran: true,
			passed: false,
			rounds: 2,
			lastCommand: "npm test",
		});
		cp.recordPlan({
			summary: "重构登录模块",
			steps: [
				{ id: "P1", label: "抽取服务层", status: "completed" },
				{ id: "P2", label: "接入状态管理", status: "running" },
			],
		});
		cp.recordMilestone("验证失败");
		cp.setTurns(7);
		cp.save(TMP);

		const restored = ProjectCheckpoint.fromFile(TMP);
		const snap = restored.snapshot();
		expect(snap.filesRead).toContain("a.ts");
		expect(snap.filesWritten.sort()).toEqual(["b.ts", "c.ts"]);
		expect(snap.verify.ran).toBe(true);
		expect(snap.verify.rounds).toBe(2);
		expect(snap.verify.lastCommand).toBe("npm test");
		expect(snap.plan?.total).toBe(2);
		expect(snap.plan?.completed).toBe(1);
		expect(snap.milestones).toContain("验证失败");
		expect(snap.turnsUsed).toBe(7);
		expect(loadCheckpointContext(TMP)).toContain("已修改 2 个文件");
		expect(loadCheckpointContext(TMP)).toContain("验证: 失败");
	});

	it("plans: recordPlan → save 写计划文档，同计划覆盖，新计划新文件", () => {
		const cp = new ProjectCheckpoint();
		cp.recordPlan({
			summary: "重构登录模块",
			steps: [
				{ id: "P1", label: "抽取服务层", status: "completed" },
				{ id: "P2", label: "接入状态管理", status: "running" },
			],
		});
		cp.save(TMP);

		// checkpoint.json 记录 planFile 路径
		const snap = JSON.parse(
			fs.readFileSync(path.join(TMP, ".xuancode", "checkpoint.json"), "utf-8"),
		);
		expect(snap.planFile).toMatch(
			/^plans[\/]\d{4}-\d{2}-\d{2}-[a-z0-9]{6}\.md$/,
		);

		// 计划文档存在且内容含步骤状态
		const planPath = path.join(TMP, ".xuancode", snap.planFile);
		expect(fs.existsSync(planPath)).toBe(true);
		const md = fs.readFileSync(planPath, "utf-8");
		expect(md).toContain("# 计划：重构登录模块");
		expect(md).toContain("[✓] **P1** 抽取服务层");
		expect(md).toContain("[▶] **P2** 接入状态管理");

		// 同计划再次 save → 覆盖同一文件（不产生新文件）
		cp.save(TMP);
		const plansDir = path.join(TMP, ".xuancode", "plans");
		expect(fs.readdirSync(plansDir).length).toBe(1);

		// 新计划（summary 变化）→ 新文件
		cp.recordPlan({
			summary: "迁移数据库",
			steps: [{ id: "P1", label: "备份", status: "pending" }],
		});
		cp.save(TMP);
		expect(fs.readdirSync(plansDir).length).toBe(2);

		// fromFile 续接恢复 planFile
		const cp2 = ProjectCheckpoint.fromFile(TMP);
		cp2.recordPlan({
			summary: "迁移数据库",
			steps: [{ id: "P1", label: "备份", status: "completed" }],
		});
		cp2.save(TMP);
		expect(fs.readdirSync(plansDir).length).toBe(2);
	});

	it("B3: writeResumeState → readResumeState → clearResumeState 往返", () => {
		const resumeId = "task-abc";
		expect(readResumeState(TMP, resumeId)).toBeNull();

		const state = {
			version: 1,
			messages: [
				{ role: "user" as const, content: "任务目标" },
				{
					role: "assistant" as const,
					content: '{"type":"write_file","path":"x.ts"}',
				},
				{ role: "user" as const, content: '工具结果: {"success":true}' },
			],
			turnCount: 3,
			stopReason: undefined,
			updatedAt: Date.now(),
		};
		writeResumeState(TMP, resumeId, state);

		const read = readResumeState(TMP, resumeId);
		expect(read).not.toBeNull();
		expect(read?.turnCount).toBe(3);
		expect(read?.messages).toHaveLength(3);
		expect(read?.messages[0].content).toBe("任务目标");

		// 不同 resumeId 互不干扰
		expect(readResumeState(TMP, "other-task")).toBeNull();

		clearResumeState(TMP, resumeId);
		expect(readResumeState(TMP, resumeId)).toBeNull();
	});

	it("B3: 损坏的 resume 文件读回 null", () => {
		const dir = path.join(TMP, ".xuancode");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "resume-corrupt.json"), "not json {");
		expect(readResumeState(TMP, "corrupt")).toBeNull();
	});
});
