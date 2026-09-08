import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoSlug, sanitizeRepoSlug, simpleHash } from "./repoSlug";

const savedHome = process.env.HOME;
afterEach(() => {
	if (savedHome === undefined) Reflect.deleteProperty(process.env, "HOME");
	else process.env.HOME = savedHome;
});

describe("simpleHash", () => {
	it("与原 daemon 实现一致：稳定且为 base36", () => {
		expect(simpleHash("abc")).toBe(simpleHash("abc"));
		expect(simpleHash("abc")).not.toBe(simpleHash("abd"));
		expect(simpleHash("")).toBe("0");
		expect(Number.parseInt(simpleHash("xyz"), 36)).not.toBeNaN();
	});
});

describe("sanitizeRepoSlug", () => {
	it("小写 + 非法字符转 - + 限长 80", () => {
		expect(sanitizeRepoSlug("My Repo!")).toBe("my-repo");
		expect(sanitizeRepoSlug("a".repeat(120)).length).toBe(80);
	});
});

describe("repoSlug", () => {
	it("无 origin 仓库 → basename-hash 兜底且稳定", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "slug-no-git-"));
		// 无 .git 目录，git 会失败 → 哈希兜底
		const s1 = repoSlug(dir);
		const s2 = repoSlug(dir);
		expect(s1).toBe(s2);
		expect(s1).toMatch(/^[a-z0-9_-]{1,80}$/);
		expect(s1).toContain(path.basename(dir).toLowerCase().slice(0, 8));
	});

	it("有 git origin → owner__repo", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "slug-git-"));
		try {
			fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
			execFileSync("git", ["init", "-q"], { cwd: dir });
			execFileSync(
				"git",
				["remote", "add", "origin", "https://github.com/Acme/my-repo.git"],
				{ cwd: dir },
			);
			expect(repoSlug(dir)).toBe("acme__my-repo");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
