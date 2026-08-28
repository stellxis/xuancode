import { describe, expect, it } from "vitest";
import { checkPermission, getModeDescription } from "./permissionPipeline";

describe("permissionPipeline", () => {
	it("should block write in plan mode", () => {
		const result = checkPermission({
			toolType: "write_file",
			params: { path: "test.ts", content: "data" },
			mode: "plan",
			workDir: "/test",
		});
		expect(result.allowed).toBe(false);
	});

	it("should allow read in plan mode", () => {
		const result = checkPermission({
			toolType: "read_file",
			params: { path: "test.ts" },
			mode: "plan",
			workDir: "/test",
		});
		expect(result.allowed).toBe(true);
	});

	it("should ask for shell command in default mode", () => {
		const result = checkPermission({
			toolType: "shell",
			params: { command: "ls -la" },
			mode: "default",
			workDir: "/test",
		});
		expect(result.requireConfirm).toBe(true);
	});

	it("should block dangerous shell commands", () => {
		const result = checkPermission({
			toolType: "shell",
			params: { command: "rm -rf /" },
			mode: "default",
			workDir: "/test",
		});
		expect(result.allowed).toBe(false);
	});

	it("should auto-allow safe commands in trust mode", () => {
		const result = checkPermission({
			toolType: "shell",
			params: { command: "ls -la" },
			mode: "trust",
			workDir: "/test",
		});
		expect(result.requireConfirm).toBe(false);
	});

	it("should allow everything in bypass mode", () => {
		const result = checkPermission({
			toolType: "write_file",
			params: { path: "test.ts", content: "data" },
			mode: "bypass",
			workDir: "/test",
		});
		expect(result.allowed).toBe(true);
	});

	it("should block protected file writes", () => {
		const result = checkPermission({
			toolType: "write_file",
			params: { path: ".env" },
			mode: "trust",
			workDir: "/test",
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("保护文件");
	});

	it("getModeDescription should return descriptions", () => {
		const desc = getModeDescription("plan");
		expect(desc).toContain("观");
		expect(desc).toContain("只读");
	});
});
