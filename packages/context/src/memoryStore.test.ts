import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./memoryStore";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memstore-"));
	process.env.XUANCODE_HOME = tmpDir;
});

afterEach(async () => {
	Reflect.deleteProperty(process.env, "XUANCODE_HOME");
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("MemoryStore — per-item md 事实源", () => {
	it("mergeLearnings 后每条记忆落一个 items/<id>.md", async () => {
		const store = new MemoryStore(tmpDir);
		await store.mergeLearnings(["用户偏好深色主题", "项目使用 pnpm"], "s1");
		const files = (await fs.readdir(path.join(tmpDir, "items"))).filter((f) =>
			f.endsWith(".md"),
		);
		expect(files.length).toBe(2);
		const raw = await fs.readFile(
			path.join(tmpDir, "items", files[0]),
			"utf-8",
		);
		expect(raw.startsWith("---")).toBe(true);
		expect(raw).toContain("id: mem-");
	});

	it("save 同步生成 MEMORY.md（过渡期旧版本降级读取）", async () => {
		const store = new MemoryStore(tmpDir);
		await store.mergeLearnings(["测试记忆条目"], "s1");
		const md = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf-8");
		expect(md).toContain("测试记忆条目");
	});

	it("load 从 items/ 目录恢复", async () => {
		const store1 = new MemoryStore(tmpDir);
		await store1.mergeLearnings(["需要跨会话保留的记忆"], "s1");
		const store2 = new MemoryStore(tmpDir);
		await store2.load();
		expect(store2.getAll().length).toBe(1);
		expect(store2.getAll()[0].text).toBe("需要跨会话保留的记忆");
	});

	it("load 从旧 MEMORY.json 迁移（改名 .bak）", async () => {
		await fs.mkdir(tmpDir, { recursive: true });
		await fs.writeFile(
			path.join(tmpDir, "MEMORY.json"),
			JSON.stringify([
				{
					id: "mem-legacy-1",
					text: "旧 JSON 记忆",
					tags: ["pattern"],
					weight: 0.6,
					pinned: false,
					createdAt: Date.now(),
					lastAccessedAt: Date.now(),
					accessCount: 1,
				},
			]),
			"utf-8",
		);
		const store = new MemoryStore(tmpDir);
		await store.load();
		expect(store.getAll().length).toBe(1);
		expect(store.getAll()[0].text).toBe("旧 JSON 记忆");
		// 迁移后：items/ 生成、旧文件改名 .bak
		expect(
			await fs.access(path.join(tmpDir, "items")).then(
				() => true,
				() => false,
			),
		).toBe(true);
		expect(
			await fs.access(path.join(tmpDir, "MEMORY.json.bak")).then(
				() => true,
				() => false,
			),
		).toBe(true);
	});

	it("load 从旧 MEMORY.md 迁移", async () => {
		await fs.writeFile(
			path.join(tmpDir, "MEMORY.md"),
			"# 玄码自动记忆\n\n- [preference] 用户喜欢简洁回复\n- 项目用 pnpm\n",
			"utf-8",
		);
		const store = new MemoryStore(tmpDir);
		await store.load();
		expect(store.getAll().length).toBe(2);
	});

	it("deleteItem 后对应 items 文件被清理", async () => {
		const store = new MemoryStore(tmpDir);
		await store.mergeLearnings(["待删除的记忆"], "s1");
		const id = store.getAll()[0].id;
		await store.deleteItem(id);
		const files = (await fs.readdir(path.join(tmpDir, "items"))).filter((f) =>
			f.endsWith(".md"),
		);
		expect(files.length).toBe(0);
	});

	it("dedup：相似文本走 reinforce 而非新建", async () => {
		const store = new MemoryStore(tmpDir);
		await store.mergeItem("用户偏好使用 pnpm 管理依赖", ["pattern"], "s1");
		await store.mergeItem("用户偏好使用 pnpm 管理依赖", ["pattern"], "s2");
		expect(store.getAll().length).toBe(1);
		expect(store.getAll()[0].accessCount).toBe(2);
	});
});
