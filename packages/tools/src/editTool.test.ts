import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { editFile } from "./editTool";

const TEST_DIR = path.join(process.cwd(), ".test-edittmp");

describe("editFile", () => {
	beforeEach(() => {
		if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(TEST_DIR, "test.txt"),
			"hello world\nfoo bar\nhello world",
		);
	});

	afterAll(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("should replace text in file", async () => {
		const result = await editFile(TEST_DIR, "test.txt", "foo bar", "baz qux");
		expect(result.success).toBe(true);
		const content = fs.readFileSync(path.join(TEST_DIR, "test.txt"), "utf-8");
		expect(content).toContain("baz qux");
	});

	it("should reject non-unique matches without replaceAll", async () => {
		const result = await editFile(
			TEST_DIR,
			"test.txt",
			"hello world",
			"goodbye",
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("出现多次");
	});

	it("should handle replaceAll option", async () => {
		const result = await editFile(
			TEST_DIR,
			"test.txt",
			"hello world",
			"goodbye",
			{ replaceAll: true },
		);
		expect(result.success).toBe(true);
		const content = fs.readFileSync(path.join(TEST_DIR, "test.txt"), "utf-8");
		expect(content).not.toContain("hello world");
		expect(content).toContain("goodbye");
	});

	it("should reject path traversal", async () => {
		const result = await editFile(TEST_DIR, "../outside.txt", "x", "y");
		expect(result.success).toBe(false);
	});

	it("should report missing text", async () => {
		const result = await editFile(
			TEST_DIR,
			"test.txt",
			"nonexistent text",
			"new",
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("未找到");
	});

	it("should report missing file", async () => {
		const result = await editFile(TEST_DIR, "missing.txt", "x", "y");
		expect(result.success).toBe(false);
	});

	it("should include duration in result", async () => {
		const result = await editFile(TEST_DIR, "test.txt", "foo bar", "baz");
		expect(result.duration).toBeGreaterThanOrEqual(0);
	});
});
