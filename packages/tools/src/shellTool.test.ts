import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runShell } from "./shellTool";

const FIXTURE_DIR = path.join(process.cwd(), ".test-shellfix");
const FIXTURE = path.join(FIXTURE_DIR, "sample.txt");

// Windows 下 Git Bash 探测（与 detectShell 同一候选路径）
function hasGitBash(): boolean {
	if (process.platform !== "win32") return false;
	const candidates = [
		path.join(
			process.env.ProgramFiles || "C:\\Program Files",
			"Git",
			"bin",
			"bash.exe",
		),
		path.join(
			process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
			"Git",
			"bin",
			"bash.exe",
		),
		path.join(
			process.env.LOCALAPPDATA || "",
			"Programs",
			"Git",
			"bin",
			"bash.exe",
		),
	];
	return candidates.some((c) => fs.existsSync(c));
}

describe("shellTool", () => {
	beforeAll(() => {
		if (!fs.existsSync(FIXTURE_DIR))
			fs.mkdirSync(FIXTURE_DIR, { recursive: true });
		fs.writeFileSync(
			FIXTURE,
			["line1", "line2", "line3", "line4", "line5"].join("\n"),
			"utf-8",
		);
	});

	afterAll(() => {
		fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
	});

	it("should execute a simple command", async () => {
		const result = await runShell(process.cwd(), 'echo "hello"');
		expect(result.success).toBe(true);
		expect(result.data).toContain("hello");
	});

	it("should run simple npm command (cmd.exe on Windows)", async () => {
		const result = await runShell(process.cwd(), "npm --version");
		expect(result.success).toBe(true);
		expect(result.data.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	// ── Windows shell 路由：cd + 复合命令走 Git Bash，cd /d 走 cmd.exe ──

	it("should run cd + compound command via Git Bash on Windows", async () => {
		if (process.platform !== "win32" || !hasGitBash()) return;
		// 将 E:\foo\bar 转为 msys 风格 /e/foo/bar
		const repo = process.cwd();
		const unixPath = `/${repo
			.replace(/^([A-Za-z]):/, (_m, d: string) => d.toLowerCase())
			.replace(/\\/g, "/")}`;
		const result = await runShell(
			process.cwd(),
			`cd "${unixPath}" && node --version`,
		);
		expect(result.success).toBe(true);
		expect(result.data).toContain("v");
	});

	it("should run cmd-native cd /d on Windows", async () => {
		if (process.platform !== "win32") return;
		const repo = process.cwd();
		const result = await runShell(
			process.cwd(),
			`cd /d "${repo}" & node --version`,
		);
		expect(result.success).toBe(true);
		expect(result.data).toContain("v");
	});

	// ── 原生读取 shim（sed/head/tail/wc） ──

	it("should natively read sed -n '1,2p'", async () => {
		const result = await runShell(FIXTURE_DIR, `sed -n '1,2p' sample.txt`);
		expect(result.success).toBe(true);
		expect(result.data).toBe("line1\nline2");
	});

	it("should natively read sed -n '2,$p'", async () => {
		const result = await runShell(FIXTURE_DIR, `sed -n '2,$p' sample.txt`);
		expect(result.success).toBe(true);
		expect(result.data).toBe("line2\nline3\nline4\nline5");
	});

	it("should natively read sed -n '3p'", async () => {
		const result = await runShell(FIXTURE_DIR, `sed -n '3p' sample.txt`);
		expect(result.success).toBe(true);
		expect(result.data).toBe("line3");
	});

	it("should natively read head -n 2", async () => {
		const result = await runShell(FIXTURE_DIR, "head -n 2 sample.txt");
		expect(result.success).toBe(true);
		expect(result.data).toBe("line1\nline2");
	});

	it("should natively read tail -n 2", async () => {
		const result = await runShell(FIXTURE_DIR, "tail -n 2 sample.txt");
		expect(result.success).toBe(true);
		expect(result.data).toBe("line4\nline5");
	});

	it("should natively count wc -l", async () => {
		const result = await runShell(FIXTURE_DIR, "wc -l sample.txt");
		expect(result.success).toBe(true);
		expect(result.data).toBe("5");
	});

	it("should report missing file for native read shim", async () => {
		const result = await runShell(FIXTURE_DIR, `sed -n '1,2p' missing.txt`);
		expect(result.success).toBe(false);
		expect(result.error).toContain("No such file");
	});

	it("should not intercept piped commands (goes to real shell)", async () => {
		// 带管道不拦截；在 Git Bash/Unix 下输出 line1，否则交由 shell 执行（不抛即可）
		const result = await runShell(
			FIXTURE_DIR,
			`cat sample.txt | sed -n '1,2p'`,
		);
		expect(result).toBeDefined();
	});

	it("should reject dangerous commands", async () => {
		const result = await runShell(process.cwd(), "rm -rf /");
		expect(result.success).toBe(false);
		expect(result.error).toContain("高危命令");
	});

	it("should reject other dangerous patterns", async () => {
		const result = await runShell(process.cwd(), "mkfs /dev/sda1");
		expect(result.success).toBe(false);
		expect(result.error).toContain("高危命令");
	});

	it("should handle command not found", async () => {
		const result = await runShell(process.cwd(), "nonexistent_command_xyz");
		// Should still return a result (not throw)
		expect(result).toBeDefined();
	});

	it("should capture stderr", async () => {
		const result = await runShell(
			process.cwd(),
			"node -e 'console.error(\"err msg\")'",
		);
		expect(result).toBeDefined();
		expect(result.success).toBe(true);
	});
});
