import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupHomeRoot, cleanupProjectRoot } from "./gc";

let tmpHome: string;
let tmpWork: string;

beforeEach(async () => {
	tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gc-home-"));
	tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), "gc-work-"));
	process.env.XUANCODE_HOME = tmpHome;
});

afterEach(async () => {
	Reflect.deleteProperty(process.env, "XUANCODE_HOME");
	await fs.rm(tmpHome, { recursive: true, force: true });
	await fs.rm(tmpWork, { recursive: true, force: true });
});

async function makeOld(p: string, days = 10): Promise<void> {
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, "old", "utf-8");
	const old = new Date(Date.now() - days * 86_400_000);
	await fs.utimes(p, old, old);
}

describe("cleanupHomeRoot", () => {
	it("删除根目录过期 code-index-*.json（旧布局残留）", async () => {
		const root = path.join(tmpHome, ".xuancode");
		await makeOld(path.join(root, "code-index-abc123.json"));
		const deleted = await cleanupHomeRoot(tmpHome, { minIntervalMs: 0 });
		expect(deleted).toBeGreaterThanOrEqual(1);
		await expect(
			fs.access(path.join(root, "code-index-abc123.json")),
		).rejects.toThrow();
	});

	it("保留新位置 cache/code-index/ 下的索引", async () => {
		const root = path.join(tmpHome, ".xuancode");
		await makeOld(path.join(root, "cache", "code-index", "my-repo.json"));
		await cleanupHomeRoot(tmpHome, { minIntervalMs: 0 });
		await expect(
			fs.access(path.join(root, "cache", "code-index", "my-repo.json")),
		).resolves.toBeUndefined();
	});

	it("删除超期日志", async () => {
		const root = path.join(tmpHome, ".xuancode");
		await makeOld(path.join(root, "logs", "daemon-2026-01-01.log"), 30);
		const deleted = await cleanupHomeRoot(tmpHome, { minIntervalMs: 0 });
		expect(deleted).toBeGreaterThanOrEqual(1);
	});

	it("minIntervalMs 内不重复执行", async () => {
		const root = path.join(tmpHome, ".xuancode");
		// 第一次调用：写入 .last-cleanup 标记
		await cleanupHomeRoot(tmpHome, { minIntervalMs: 86_400_000 });
		// 之后添加过期文件
		await makeOld(path.join(root, "code-index-abc.json"));
		// 间隔未到 → 跳过清理
		const deleted = await cleanupHomeRoot(tmpHome, {
			minIntervalMs: 86_400_000,
		});
		expect(deleted).toBe(0);
		// 文件仍在
		await expect(
			fs.access(path.join(root, "code-index-abc.json")),
		).resolves.toBeUndefined();
	});

	it("删除 30 天未动的孤儿记忆 scope，保留活跃 scope", async () => {
		const root = path.join(tmpHome, ".xuancode");
		await makeOld(
			path.join(root, "memory", "projects", "orphan-proj", "MEMORY.md"),
			40,
		);
		await makeOld(
			path.join(root, "memory", "projects", "active-proj", "MEMORY.md"),
			40,
		);
		await cleanupHomeRoot(tmpHome, {
			minIntervalMs: 0,
			activeProjectSlugs: ["active-proj"],
		});
		await expect(
			fs.access(path.join(root, "memory", "projects", "orphan-proj")),
		).rejects.toThrow();
		await expect(
			fs.access(path.join(root, "memory", "projects", "active-proj")),
		).resolves.toBeUndefined();
	});
});

describe("cleanupProjectRoot", () => {
	it("删除无 transcript 的孤儿会话目录，保留有效会话", async () => {
		const root = path.join(tmpWork, ".xuancode");
		const sessions = path.join(root, "sessions");
		// 孤儿：空目录
		await fs.mkdir(path.join(sessions, "orphan-s"), { recursive: true });
		const old = new Date(Date.now() - 10 * 86_400_000);
		await fs.utimes(path.join(sessions, "orphan-s"), old, old);
		// 有效：有 transcript
		const validDir = path.join(sessions, "valid-s");
		await fs.mkdir(validDir, { recursive: true });
		await fs.writeFile(
			path.join(validDir, "transcript.jsonl"),
			"{}\n",
			"utf-8",
		);
		await fs.utimes(validDir, old, old);

		const deleted = await cleanupProjectRoot(root, { minIntervalMs: 0 });
		expect(deleted).toBeGreaterThanOrEqual(1);
		await expect(fs.access(path.join(sessions, "orphan-s"))).rejects.toThrow();
		await expect(fs.access(validDir)).resolves.toBeUndefined();
	});

	it("删除 30 天未动的计划文档", async () => {
		const root = path.join(tmpWork, ".xuancode");
		await makeOld(path.join(root, "plans", "2026-08-01-abc123.md"), 40);
		const deleted = await cleanupProjectRoot(root, { minIntervalMs: 0 });
		expect(deleted).toBeGreaterThanOrEqual(1);
	});

	it("删除超期 merge-tmp", async () => {
		const root = path.join(tmpWork, ".xuancode");
		await makeOld(path.join(root, "merge-tmp", "file-base.ts"), 10);
		const deleted = await cleanupProjectRoot(root, { minIntervalMs: 0 });
		expect(deleted).toBeGreaterThanOrEqual(1);
	});
});
