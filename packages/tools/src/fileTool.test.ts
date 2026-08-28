import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readFile, writeFile } from "./fileTool";

const TEST_DIR = path.join(process.cwd(), ".test-filetmp");

describe("fileTool", () => {
	beforeAll(() => {
		if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
	});

	it("should read a file", async () => {
		fs.writeFileSync(path.join(TEST_DIR, "test.txt"), "hello world");
		const result = await readFile(TEST_DIR, "test.txt");
		expect(result.success).toBe(true);
		expect(result.data).toBe("hello world");
	});

	it("should read a line range (startLine/endLine, 1-indexed inclusive)", async () => {
		fs.writeFileSync(
			path.join(TEST_DIR, "lines.txt"),
			["a", "b", "c", "d"].join("\n"),
			"utf-8",
		);
		const result = await readFile(TEST_DIR, "lines.txt", {
			startLine: 2,
			endLine: 3,
		});
		expect(result.success).toBe(true);
		expect(result.data).toContain(
			"===== lines.txt (第 2-3 行 / 共 4 行) =====",
		);
		expect(result.data).toContain("b\nc");
	});

	it("should read a single line when only startLine given", async () => {
		fs.writeFileSync(
			path.join(TEST_DIR, "lines.txt"),
			["a", "b", "c", "d"].join("\n"),
			"utf-8",
		);
		const result = await readFile(TEST_DIR, "lines.txt", { startLine: 4 });
		expect(result.success).toBe(true);
		expect(result.data).toContain("d");
		expect(result.data).not.toContain("c");
	});

	it("should write a file", async () => {
		const result = await writeFile(TEST_DIR, "write-test.txt", "content");
		expect(result.success).toBe(true);
		expect(
			fs.readFileSync(path.join(TEST_DIR, "write-test.txt"), "utf-8"),
		).toBe("content");
	});

	it("should reject path traversal", async () => {
		const result = await readFile(TEST_DIR, "../outside.txt");
		expect(result.success).toBe(false);
	});

	it("should report error for non-existent file", async () => {
		const result = await readFile(TEST_DIR, "nonexistent.txt");
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("C4: should read a line range from a file larger than MAX_FILE_SIZE (streaming)", async () => {
		// >1MB 文件（约 9000 行），之前会被硬拒
		const bigPath = path.join(TEST_DIR, "big.txt");
		const lines = Array.from(
			{ length: 9000 },
			(_, i) => `line-${i + 1}-${"x".repeat(120)}`,
		);
		fs.writeFileSync(bigPath, lines.join("\n"), "utf-8");
		expect(fs.statSync(bigPath).size).toBeGreaterThan(1024 * 1024);

		const result = await readFile(TEST_DIR, "big.txt", {
			startLine: 5000,
			endLine: 5003,
		});
		expect(result.success).toBe(true);
		expect(result.data).toContain("第 5000-5003 行");
		expect(result.data).toContain("line-5000-");
		expect(result.data).toContain("line-5003-");
		expect(result.data).not.toContain("line-5004-");
	});

	it("C4: should return progressive head for large file without range instead of rejecting", async () => {
		const result = await readFile(TEST_DIR, "big.txt");
		expect(result.success).toBe(true);
		expect(result.data).toContain("已显示前");
		expect(result.data).toContain("line-1-");
		expect(result.data).not.toContain("line-9000-");
		// 不载入整个文件：返回内容远小于文件大小
		expect(result.data.length).toBeLessThan(1024 * 1024);
	});
});
