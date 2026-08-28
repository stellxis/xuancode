import fs from "node:fs";
import path from "node:path";
import { ToolType } from "@xuancode/types";
import { beforeAll, describe, expect, it } from "vitest";
import { ToolManager } from "./toolManager";

const TEST_DIR = path.join(process.cwd(), ".test-tmp");

describe("ToolManager", () => {
	beforeAll(() => {
		if (!fs.existsSync(TEST_DIR)) {
			fs.mkdirSync(TEST_DIR, { recursive: true });
		}
	});

	it("should read a file", async () => {
		const testFile = path.join(TEST_DIR, "test.txt");
		fs.writeFileSync(testFile, "hello world");
		const tm = new ToolManager(TEST_DIR);
		const result = await tm.dispatch({
			type: ToolType.READ_FILE,
			path: "test.txt",
		});
		expect(result.success).toBe(true);
		expect(result.data).toBe("hello world");
	});

	it("should write a file", async () => {
		const tm = new ToolManager(TEST_DIR);
		const result = await tm.dispatch({
			type: ToolType.WRITE_FILE,
			path: "new.txt",
			content: "new content",
		});
		expect(result.success).toBe(true);
		expect(fs.readFileSync(path.join(TEST_DIR, "new.txt"), "utf-8")).toBe(
			"new content",
		);
	});

	it("should list directory", async () => {
		const tm = new ToolManager(TEST_DIR);
		const result = await tm.dispatch({ type: ToolType.LIST_DIR, path: "." });
		expect(result.success).toBe(true);
		expect(result.data).toContain("test.txt");
	});

	it("should reject unknown tool type", async () => {
		const tm = new ToolManager(TEST_DIR);
		const result = await tm.dispatch({ type: "unknown_tool" });
		expect(result.success).toBe(false);
	});

	it("edit_file 通过 dispatch 用 snake_case 参数（old_string/new_string）正常编辑", async () => {
		const testFile = path.join(TEST_DIR, "edit-dispatch.txt");
		fs.writeFileSync(testFile, "数字测试 123\n第二行\n");
		const tm = new ToolManager(TEST_DIR);
		// 回归：此前 dispatcher 读 p.oldString（camelCase）→ undefined → editFile 内 normalizeLf 抛
		// "Cannot read properties of undefined (reading 'replace')"
		const result = await tm.dispatch({
			type: ToolType.EDIT_FILE,
			path: "edit-dispatch.txt",
			old_string: "数字测试 123",
			new_string: "编辑测试 456 (edit_file 生效)",
		});
		expect(result.success).toBe(true);
		expect(fs.readFileSync(testFile, "utf-8")).toContain(
			"编辑测试 456 (edit_file 生效)",
		);
		expect(fs.readFileSync(testFile, "utf-8")).not.toContain("数字测试 123");
	});

	it("edit_file 未匹配时返回失败而非抛异常", async () => {
		const testFile = path.join(TEST_DIR, "edit-nomatch.txt");
		fs.writeFileSync(testFile, "第一行\n");
		const tm = new ToolManager(TEST_DIR);
		const result = await tm.dispatch({
			type: ToolType.EDIT_FILE,
			path: "edit-nomatch.txt",
			old_string: "不存在的文本",
			new_string: "替换",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("未找到匹配");
	});

	it("should generate tool prompt with all registered tools", () => {
		const tm = new ToolManager(TEST_DIR);
		const prompt = tm.generateToolPrompt();
		expect(prompt).toContain("read_file");
		expect(prompt).toContain("edit_file");
		expect(prompt).toContain("write_file");
		expect(prompt).toContain("list_dir");
		expect(prompt).toContain("shell");
		expect(prompt).toContain("glob");
		expect(prompt).toContain("grep");
		// Should have category headers
		expect(prompt).toContain("文件系统");
		expect(prompt).toContain("代码理解");
		expect(prompt).toContain("执行");
	});

	it("should get definition for registered tool", () => {
		const tm = new ToolManager(TEST_DIR);
		const def = tm.getDefinition(ToolType.READ_FILE);
		expect(def).toBeDefined();
		expect(def?.name).toBe("read_file");
		expect(def?.category).toBe("metal");
	});

	it("should list all definitions", () => {
		const tm = new ToolManager(TEST_DIR);
		const defs = tm.getDefinitions();
		expect(defs.length).toBeGreaterThanOrEqual(7);
	});
});
