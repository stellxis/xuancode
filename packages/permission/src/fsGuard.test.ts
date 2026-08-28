import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkFileRead,
	checkFileWrite,
	checkPathTraversal,
	isProtectedFile,
	resolveToolPath,
} from "./fsGuard";

describe("fsGuard", () => {
	describe("isProtectedFile", () => {
		it("should protect .env files", () => {
			expect(isProtectedFile(".env")).toBe(true);
			expect(isProtectedFile(".env.local")).toBe(true);
		});

		it("should protect SSH keys", () => {
			expect(isProtectedFile("id_rsa")).toBe(true);
			expect(isProtectedFile("id_ed25519")).toBe(true);
		});

		it("should protect shell config", () => {
			expect(isProtectedFile(".bashrc")).toBe(true);
			expect(isProtectedFile(".zshrc")).toBe(true);
		});

		it("should protect git internals", () => {
			expect(isProtectedFile(".git/config")).toBe(true);
		});

		it("should allow normal source files", () => {
			expect(isProtectedFile("src/index.ts")).toBe(false);
		});
	});

	describe("checkPathTraversal", () => {
		it("should block traversal attacks", () => {
			const result = checkPathTraversal("/safe/dir", "../etc/passwd");
			expect(result.allowed).toBe(false);
		});

		it("should allow safe paths", () => {
			const result = checkPathTraversal("/safe/dir", "file.txt");
			expect(result.allowed).toBe(true);
		});

		it("should block paths outside root", () => {
			const result = checkPathTraversal("/safe/dir", "../../../etc/passwd");
			expect(result.allowed).toBe(false);
		});

		it("should warn on .. in path", () => {
			const result = checkPathTraversal("/safe/dir", "sub/../file.txt");
			expect(result.allowed).toBe(false);
		});
	});

	describe("checkFileWrite", () => {
		it("should block writing to protected files", () => {
			const result = checkFileWrite(".env");
			expect(result.allowed).toBe(false);
			expect(result.severity).toBe("block");
		});

		it("should allow writing to normal files", () => {
			const result = checkFileWrite("src/index.ts");
			expect(result.allowed).toBe(true);
		});
	});

	describe("checkFileRead", () => {
		it("should block reading protected files", () => {
			const result = checkFileRead("id_rsa");
			expect(result.allowed).toBe(false);
		});

		it("should allow reading normal files", () => {
			const result = checkFileRead("src/index.ts");
			expect(result.allowed).toBe(true);
		});
	});

	describe("resolveToolPath", () => {
		const workDir = "/safe/dir";

		it("should resolve relative paths within workdir", () => {
			const result = resolveToolPath(workDir, "file.txt", "default");
			expect(result.allowed).toBe(true);
			expect(result.resolvedPath).toBe(path.resolve("/safe/dir", "file.txt"));
		});

		it("should block absolute paths in plan/default mode", () => {
			const result = resolveToolPath(workDir, "/etc/passwd", "default");
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("绝对路径");
		});

		it("should allow absolute paths in trust mode (level >= 2)", () => {
			const result = resolveToolPath(workDir, "/etc/passwd", "trust");
			expect(result.allowed).toBe(true);
			expect(result.resolvedPath).toBe("/etc/passwd");
		});

		it("should block absolute protected files below auto mode", () => {
			const result = resolveToolPath(workDir, "/.env", "trust");
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("保护文件");
		});

		it("should allow absolute protected files in auto mode", () => {
			const result = resolveToolPath(workDir, "/.env", "auto");
			expect(result.allowed).toBe(true);
		});

		it("should block traversal attacks", () => {
			const result = resolveToolPath(workDir, "../etc/passwd", "trust");
			expect(result.allowed).toBe(false);
		});

		it("should block paths outside workdir", () => {
			const result = resolveToolPath(workDir, "../../../etc/passwd", "bypass");
			expect(result.allowed).toBe(false);
		});
	});
});
