import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	migrateHomeDir,
	migrateProjectData,
	migrateServerData,
} from "./migrate";

let tmpHome: string;
let tmpWork: string;

beforeEach(async () => {
	tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mig-home-"));
	tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), "mig-work-"));
	process.env.XUANCODE_HOME = tmpHome;
	Reflect.deleteProperty(process.env, "XUANCODE_PROJECT_DATA");
	Reflect.deleteProperty(process.env, "XUANCODE_SERVER_DATA");
});

afterEach(async () => {
	Reflect.deleteProperty(process.env, "XUANCODE_HOME");
	Reflect.deleteProperty(process.env, "XUANCODE_PROJECT_DATA");
	Reflect.deleteProperty(process.env, "XUANCODE_SERVER_DATA");
	await fs.rm(tmpHome, { recursive: true, force: true });
	await fs.rm(tmpWork, { recursive: true, force: true });
});

describe("migrateHomeDir", () => {
	it("创建 memory 与 cache/code-index 目录并留标记", async () => {
		await migrateHomeDir();
		expect(
			await fs.stat(path.join(tmpHome, ".xuancode", "memory")),
		).toBeTruthy();
		expect(
			await fs.stat(path.join(tmpHome, ".xuancode", "cache", "code-index")),
		).toBeTruthy();
		expect(
			await fs.stat(path.join(tmpHome, ".xuancode", ".migrated-v2")),
		).toBeTruthy();
	});

	it("幂等：二次调用不再改动", async () => {
		await migrateHomeDir();
		const marker = await fs.readFile(
			path.join(tmpHome, ".xuancode", ".migrated-v2"),
			"utf-8",
		);
		await new Promise((r) => setTimeout(r, 10));
		await migrateHomeDir();
		const marker2 = await fs.readFile(
			path.join(tmpHome, ".xuancode", ".migrated-v2"),
			"utf-8",
		);
		expect(marker2).toBe(marker);
	});
});

describe("migrateProjectData", () => {
	it("平铺 sessions/<id>.jsonl → sessions/<id>/transcript.jsonl", async () => {
		const root = path.join(tmpWork, ".xuancode");
		const sessionsDir = path.join(root, "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		await fs.writeFile(
			path.join(sessionsDir, "2026-09-08T10-00-00-000Z.jsonl"),
			'{"role":"user"}\n',
			"utf-8",
		);
		await migrateProjectData(tmpWork);
		const moved = await fs.readFile(
			path.join(sessionsDir, "2026-09-08T10-00-00-000Z", "transcript.jsonl"),
			"utf-8",
		);
		expect(moved).toContain("user");
	});

	it("session-memory.md copy 进最新会话目录且原文件保留", async () => {
		const root = path.join(tmpWork, ".xuancode");
		const sessionsDir = path.join(root, "sessions");
		const s1 = path.join(sessionsDir, "s-001-old");
		const s2 = path.join(sessionsDir, "s-002-new");
		await fs.mkdir(s1, { recursive: true });
		await fs.mkdir(s2, { recursive: true });
		await fs.writeFile(
			path.join(root, "session-memory.md"),
			"L6 内容",
			"utf-8",
		);
		await migrateProjectData(tmpWork);
		expect(await fs.readFile(path.join(s2, "session-memory.md"), "utf-8")).toBe(
			"L6 内容",
		);
		// 原文件保留（旧版本降级读取）
		expect(
			await fs.readFile(path.join(root, "session-memory.md"), "utf-8"),
		).toBe("L6 内容");
	});

	it("幂等：跑两遍结果一致", async () => {
		const root = path.join(tmpWork, ".xuancode");
		const sessionsDir = path.join(root, "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		await fs.writeFile(path.join(sessionsDir, "s1.jsonl"), "{}\n", "utf-8");
		await migrateProjectData(tmpWork);
		const snapshot1 = await listAll(root);
		await migrateProjectData(tmpWork);
		const snapshot2 = await listAll(root);
		expect(snapshot2).toEqual(snapshot1);
	});

	it("hooks.log → logs/", async () => {
		const root = path.join(tmpWork, ".xuancode");
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(path.join(root, "hooks.log"), "hook\n", "utf-8");
		await migrateProjectData(tmpWork);
		expect(
			await fs.readFile(path.join(root, "logs", "hooks.log"), "utf-8"),
		).toContain("hook");
	});
});

describe("migrateServerData", () => {
	it("copy 不 delete：旧 auth 目录数据复制到服务根并留弃用标记", async () => {
		const serverRoot = path.join(tmpHome, ".xuancode", "server");
		const legacy = path.join(tmpWork, ".xuancode", "auth");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(
			path.join(legacy, "users.jsonl"),
			'{"id":"u1"}\n',
			"utf-8",
		);
		await migrateServerData(serverRoot, [path.join(tmpWork, ".xuancode")]);
		expect(
			await fs.readFile(path.join(serverRoot, "auth", "users.jsonl"), "utf-8"),
		).toContain("u1");
		// 旧数据保留 + 弃用标记
		expect(
			await fs.readFile(path.join(legacy, "users.jsonl"), "utf-8"),
		).toContain("u1");
		expect(
			await fs.stat(path.join(legacy, "DEPRECATED-moved-to-server-root")),
		).toBeTruthy();
	});
});

async function listAll(dir: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (d: string): Promise<void> => {
		for (const e of await fs.readdir(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else out.push(p);
		}
	};
	await walk(dir);
	return out.sort();
}
