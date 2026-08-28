import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ProjectCheckpoint,
	formatCheckpointSnapshot,
	loadCheckpointContext,
} from "./projectCheckpoint";
import {
	evaluateVerifyGate,
	extractVerifyErrors,
	isVerifyCommand,
	truncateCompileOutput,
} from "./verify";

describe("isVerifyCommand", () => {
	it("识别编译命令", () => {
		expect(isVerifyCommand("npm run build")).toBe(true);
		expect(isVerifyCommand("tsc --noEmit")).toBe(true);
		expect(isVerifyCommand("cargo build")).toBe(true);
		expect(isVerifyCommand("make")).toBe(true);
		expect(isVerifyCommand("pnpm run typecheck")).toBe(true);
	});

	it("识别测试命令", () => {
		expect(isVerifyCommand("npm test")).toBe(true);
		expect(isVerifyCommand("pytest")).toBe(true);
		expect(isVerifyCommand("npx vitest run")).toBe(true);
		expect(isVerifyCommand("go test ./...")).toBe(true);
	});

	it("识别 git 验证导向命令（配置/仓库类任务）", () => {
		expect(isVerifyCommand("git check-ignore target/")).toBe(true);
		expect(isVerifyCommand("git check-ignore -v node_modules")).toBe(true);
		expect(isVerifyCommand("git diff --check")).toBe(true);
		expect(isVerifyCommand("git diff --cached --check")).toBe(true);
		expect(isVerifyCommand("git diff --exit-code")).toBe(true);
		expect(isVerifyCommand("git diff --cached --exit-code")).toBe(true);
		expect(isVerifyCommand("git status --porcelain")).toBe(true);
		expect(isVerifyCommand("git status -s")).toBe(true);
		expect(isVerifyCommand("git ls-files --error-unmatch .env")).toBe(true);
		expect(
			isVerifyCommand("git ls-files --others --ignored --exclude-standard"),
		).toBe(true);
	});

	it("普通命令不算验证", () => {
		expect(isVerifyCommand("node server.js")).toBe(false);
		expect(isVerifyCommand("ls -la")).toBe(false);
		expect(isVerifyCommand("git status")).toBe(false);
		expect(isVerifyCommand("git log --oneline -3")).toBe(false);
		expect(isVerifyCommand("git diff")).toBe(false);
		expect(isVerifyCommand("git add -A")).toBe(false);
		expect(isVerifyCommand("git commit -m init")).toBe(false);
		expect(isVerifyCommand("")).toBe(false);
	});
});

describe("extractVerifyErrors", () => {
	it("提取 file:line:col 错误行并去重", () => {
		const output = [
			"> tsc",
			"src/a.ts:10:5 - error TS2322: Type 'string' is not assignable",
			"  src/a.ts:10:5",
			"src/b.ts:3:1 - error TS2304: Cannot find name 'x'",
			"Found 2 errors.",
		].join("\n");
		const extracted = extractVerifyErrors(output, 10);
		expect(extracted).toContain("src/a.ts:10:5");
		expect(extracted).toContain("error TS2322");
		expect(extracted).toContain("src/b.ts:3:1");
	});

	it("无错误行时回退到末尾几行", () => {
		const output = ["line1", "line2", "line3"].join("\n");
		expect(extractVerifyErrors(output, 2)).toContain("line3");
	});
});

describe("evaluateVerifyGate", () => {
	const base = {
		mode: "auto" as const,
		modified: 3,
		command: "npm test",
		maxFixRounds: 3,
		gateBlocks: 0,
		verify: { ran: false, passed: false, rounds: 0 },
	};

	it("off 模式不拦截", () => {
		const d = evaluateVerifyGate({ ...base, mode: "off" });
		expect(d.block).toBe(false);
	});

	it("未修改代码不拦截", () => {
		const d = evaluateVerifyGate({ ...base, modified: 0 });
		expect(d.block).toBe(false);
	});

	it("已验证通过不拦截", () => {
		const d = evaluateVerifyGate({
			...base,
			verify: { ran: true, passed: true, rounds: 0 },
		});
		expect(d.block).toBe(false);
	});

	it("改码未验证 → 拦截并提示", () => {
		const d = evaluateVerifyGate({
			...base,
			verify: { ran: false, passed: false, rounds: 0 },
		});
		expect(d.block).toBe(true);
		expect(d.message).toContain("尚未验证");
	});

	it("验证失败 → 拦截并带关键错误", () => {
		const d = evaluateVerifyGate({
			...base,
			verify: {
				ran: true,
				passed: false,
				rounds: 2,
				lastOutput: "src/a.ts:1:1 - error TS2322",
			},
		});
		expect(d.block).toBe(true);
		expect(d.message).toContain("已尝试 2 次");
		expect(d.message).toContain("src/a.ts:1:1");
	});

	it("拦截次数超上限后放行（避免死循环）", () => {
		const d = evaluateVerifyGate({
			...base,
			gateBlocks: base.maxFixRounds + 2,
			verify: { ran: false, passed: false, rounds: 0 },
		});
		expect(d.block).toBe(false);
	});
});

describe("truncateCompileOutput", () => {
	it("空输出返回空串", () => {
		expect(truncateCompileOutput("", 100)).toBe("");
		expect(truncateCompileOutput(undefined, 100)).toBe("");
	});

	it("短输出不截断", () => {
		expect(truncateCompileOutput("ok", 6000)).toBe("ok");
	});

	it("编译输出 → 保留错误行，丢弃中间噪声", () => {
		const noise = Array.from(
			{ length: 300 },
			(_, i) => `info 无关日志 ${i}`,
		).join("\n");
		const errs = Array.from(
			{ length: 40 },
			(_, i) => `src/a.ts:${i + 1}:5 - error TS2322: 类型不匹配 ${i}`,
		).join("\n");
		const out = `${noise}\n${errs}`;
		const t = truncateCompileOutput(out, 1000);
		expect(t.length).toBeLessThan(1000);
		expect(t).toContain("src/a.ts:1:5");
		expect(t).toContain("error TS2322");
		expect(t).toContain("[编译输出");
		expect(t).not.toContain("无关日志");
	});

	it("非编译输出 → 使用自定义 fallback", () => {
		const t = truncateCompileOutput(
			"普通文本".repeat(200),
			50,
			() => "FALLBACK",
		);
		expect(t).toBe("FALLBACK");
	});

	it("非编译输出 → 默认通用头尾截断", () => {
		const t = truncateCompileOutput("行".repeat(1000), 100);
		expect(t).toContain("省略");
		expect(t).not.toContain("[编译输出");
	});

	it("关键行太少时退回通用截断", () => {
		const out = `src/a.ts:1:1 - error TS2322: x\n${"y".repeat(8000)}`;
		const t = truncateCompileOutput(out, 6000, (_o, m) => `FB(${m})`);
		expect(t).toBe("FB(6000)");
	});
});

describe("ProjectCheckpoint", () => {
	it("记录文件与验证状态并生成摘要", () => {
		const cp = new ProjectCheckpoint();
		cp.recordRead("src/a.ts");
		cp.recordRead("src/a.ts");
		cp.recordWrite("src/b.ts");
		cp.recordVerify({ ran: true, passed: true, rounds: 0, lastCommand: "tsc" });

		const summary = cp.summary();
		expect(cp.modifiedCount).toBe(1);
		expect(summary).toContain("已修改 1 个文件");
		expect(summary).toContain("已读取 1 个文件");
		expect(summary).toContain("验证: 通过");
	});

	it("未验证时摘要提示尚未执行", () => {
		const cp = new ProjectCheckpoint();
		cp.recordWrite("src/a.ts");
		expect(cp.summary()).toContain("验证: 尚未执行");
	});

	it("无实质进展时摘要为空", () => {
		const cp = new ProjectCheckpoint();
		expect(cp.summary()).toBe("");
	});

	it("记录计划快照 → 完成数与步骤表格", () => {
		const cp = new ProjectCheckpoint();
		cp.recordPlan({
			summary: "企业网站开发",
			steps: [
				{
					id: "s1",
					label: "搭建骨架",
					status: "completed",
					subAgentType: "implement",
				},
				{ id: "s2", label: "实现首页", status: "running" },
				{ id: "s3", label: "部署上线", status: "pending" },
			],
		});
		const snap = cp.snapshot();
		expect(snap.plan?.completed).toBe(1);
		expect(snap.plan?.total).toBe(3);
		const block = cp.toContextBlock();
		expect(block).toContain("计划: 企业网站开发（1/3 步完成）");
		expect(block).toContain("[✓] s1: 搭建骨架 (implement)");
		expect(block).toContain("[▶] s2: 实现首页");
		expect(block).toContain("[ ] s3: 部署上线");
	});

	it("记录里程碑 → 追加且去重", () => {
		const cp = new ProjectCheckpoint();
		cp.recordMilestone("第一段完成");
		cp.recordMilestone("第一段完成"); // 连续重复被去重
		cp.recordMilestone("验证通过: tsc");
		expect(cp.milestoneCount).toBe(2);
		const block = cp.toContextBlock();
		expect(block).toContain("关键节点: 第一段完成 → 验证通过: tsc");
	});

	it("seed 合并 → 文件取并集、验证取最新、里程碑追加", () => {
		const prev = new ProjectCheckpoint();
		prev.recordWrite("src/a.ts");
		prev.recordVerify({ ran: true, passed: true, rounds: 0 });
		prev.recordMilestone("第一段完成");

		const next = new ProjectCheckpoint();
		next.recordWrite("src/a.ts");
		next.recordWrite("src/b.ts");
		next.seed(prev.snapshot());

		const snap = next.snapshot();
		expect(snap.filesWritten).toEqual(["src/a.ts", "src/b.ts"]); // 并集且无重复
		expect(next.modifiedCount).toBe(2);
		expect(snap.verify.passed).toBe(true); // 取 prev 的最新验证
		expect(snap.milestones).toEqual(["第一段完成"]);
	});

	it("formatCheckpointSnapshot → 含计划表格与关键节点", () => {
		const cp = new ProjectCheckpoint();
		cp.recordMilestone("确定技术栈");
		cp.recordWrite("src/a.ts");
		cp.recordVerify({
			ran: true,
			passed: false,
			rounds: 2,
			lastCommand: "tsc",
		});
		cp.recordPlan({
			summary: "企业网站开发",
			steps: [
				{
					id: "s1",
					label: "搭建骨架",
					status: "completed",
					subAgentType: "implement",
				},
				{ id: "s2", label: "实现首页", status: "pending" },
			],
		});
		const text = formatCheckpointSnapshot(cp.snapshot());
		expect(text).toContain("已修改 1 个文件");
		expect(text).toContain("验证: 失败(已尝试 2 次) [tsc]");
		expect(text).toContain("计划: 企业网站开发（1/2 步完成）");
		expect(text).toContain("[✓] s1: 搭建骨架 (implement)");
		expect(text).toContain("[ ] s2: 实现首页");
		expect(text).toContain("关键节点: 确定技术栈");
	});

	it("save + fromFile 落盘/续接（跨任务累积）", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-"));
		try {
			const cp = new ProjectCheckpoint();
			cp.recordWrite("src/a.ts");
			cp.recordWrite("src/b.ts");
			cp.recordVerify({ ran: true, passed: true, rounds: 0 });
			cp.recordMilestone("验证通过: tsc");
			cp.save(dir);

			// 下一个任务续接已有 checkpoint → 项目状态累积
			const next = ProjectCheckpoint.fromFile(dir);
			next.recordWrite("src/c.ts");
			expect(next.modifiedCount).toBe(3);

			const ctx = loadCheckpointContext(dir);
			expect(ctx).toContain("已修改 2 个文件");
			expect(ctx).toContain("验证: 通过");
			expect(ctx).toContain("关键节点: 验证通过: tsc");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
