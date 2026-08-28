import { execSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = path.join(process.cwd(), ".test-gittmp");

function git(args: string[], cwd: string = TEST_DIR): string {
	const quoted = args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
	return execSync(`git ${quoted}`, {
		cwd,
		encoding: "utf-8",
		shell: true,
	}).trim();
}

describe("git tools", () => {
	beforeAll(() => {
		if (fs.existsSync(TEST_DIR))
			fs.rmSync(TEST_DIR, { recursive: true, force: true });
		fs.mkdirSync(TEST_DIR, { recursive: true });
		git(["init"]);
		git(["config", "user.email", "test@test.com"]);
		git(["config", "user.name", "Tester"]);
		fs.writeFileSync(path.join(TEST_DIR, "README.md"), "# Test Repo");
		git(["add", "-A"]);
		git(["commit", "-m", "Initial commit"]);
		// Tag the branch name for tests
		const branchName = git(["rev-parse", "--abbrev-ref", "HEAD"]);
		process.env.TEST_BRANCH = branchName;
	});

	afterAll(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	describe("gitStatus", () => {
		it("should show repository status", async () => {
			const { gitStatus } = await import("./gitTool");
			const result = await gitStatus(TEST_DIR);
			expect(result.success).toBe(true);
			expect(result.data).toContain("分支:");
		});

		it("should detect modified files", async () => {
			const { gitStatus } = await import("./gitTool");
			fs.writeFileSync(
				path.join(TEST_DIR, "hello.ts"),
				"console.log('hello world');\n",
			);
			fs.writeFileSync(path.join(TEST_DIR, "new-file.ts"), "// new\n");
			const result = await gitStatus(TEST_DIR);
			expect(result.data).toContain("hello.ts") ||
				expect(result.data).toContain("new-file.ts");
		});

		it("should fail outside git repo", async () => {
			const { gitStatus } = await import("./gitTool");
			// Use OS temp dir to avoid any parent git repo
			const tmpDir = path.join(
				fs.realpathSync(tmpdir()),
				`.test-no-git-${Date.now()}`,
			);
			if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
			try {
				const result = await gitStatus(tmpDir);
				expect(result.success).toBe(false);
				expect(result.error).toContain("Git");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("gitDiff", () => {
		it("should show diff of unstaged changes", async () => {
			const { gitDiff } = await import("./gitTool");
			fs.writeFileSync(path.join(TEST_DIR, "diff-test.ts"), "const x = 1;\n");
			git(["add", "diff-test.ts"]);
			fs.writeFileSync(path.join(TEST_DIR, "diff-test.ts"), "const x = 2;\n");
			const result = await gitDiff(TEST_DIR);
			expect(result.success).toBe(true);
		});
	});

	describe("gitLog", () => {
		it("should show commit history", async () => {
			const { gitLog } = await import("./gitTool");
			const result = await gitLog(TEST_DIR, { count: 5 });
			expect(result.success).toBe(true);
			expect(result.data).toContain("Initial commit");
		});

		it("should include latest commit info", async () => {
			const { gitLog } = await import("./gitTool");
			const result = await gitLog(TEST_DIR, { count: 3 });
			expect(result.data).toContain("Tester") ||
				expect(result.data).toContain("Initial");
		});
	});

	describe("gitBranch", () => {
		it("should list branches", async () => {
			const { gitBranch } = await import("./gitTool");
			const result = await gitBranch(TEST_DIR, { action: "list" });
			expect(result.success).toBe(true);
			expect(result.data).toContain("分支:");
		});

		it("should create and delete branch", async () => {
			const { gitBranch } = await import("./gitTool");
			// Save original branch before switching
			const origBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], TEST_DIR);
			const branchName = `test-feature-${Date.now()}`;
			const createResult = await gitBranch(TEST_DIR, {
				action: "create",
				name: branchName,
			});
			expect(createResult.success).toBe(true);
			expect(createResult.data).toContain(branchName);

			// Switch back to original branch before deleting
			git(["checkout", origBranch]);
			const deleteResult = await gitBranch(TEST_DIR, {
				action: "delete",
				name: branchName,
			});
			expect(deleteResult.success).toBe(true);
		});
	});

	describe("gitCommit", () => {
		it("should reject empty message", async () => {
			const { gitCommit } = await import("./gitTool");
			const result = await gitCommit(TEST_DIR, "");
			expect(result.success).toBe(false);
			expect(result.error).toContain("不能为空");
		});

		it("should commit changes", async () => {
			const { gitCommit } = await import("./gitTool");
			fs.writeFileSync(path.join(TEST_DIR, "commit-test.ts"), "// test\n");
			git(["add", "commit-test.ts"]);
			const result = await gitCommit(TEST_DIR, "test: add commit-test.ts");
			expect(result.success).toBe(true);
		});
	});

	describe("gitPush", () => {
		it("should handle push without remote", async () => {
			const { gitPush } = await import("./gitTool");
			const result = await gitPush(TEST_DIR);
			expect(result.success).toBe(false);
		});
	});

	describe("ToolManager integration", () => {
		it("should have git tools in definitions", async () => {
			const { ToolManager } = await import("./toolManager");
			const tm = new ToolManager(TEST_DIR);
			const defs = tm.getDefinitions();
			const gitDefs = defs.filter((d) => d.type.startsWith("git_"));
			expect(gitDefs.length).toBeGreaterThanOrEqual(6);
		});

		it("should generate prompt with git tools", async () => {
			const { ToolManager } = await import("./toolManager");
			const tm = new ToolManager(TEST_DIR);
			const prompt = tm.generateToolPrompt();
			expect(prompt).toContain("git_status");
			expect(prompt).toContain("git_commit");
		});

		it("should dispatch git_status via ToolManager", async () => {
			const { ToolManager } = await import("./toolManager");
			const tm = new ToolManager(TEST_DIR);
			const result = await tm.dispatch({ type: "git_status" });
			expect(result.success).toBe(true);
			expect(result.data).toContain("分支:");
		});
	});
});
