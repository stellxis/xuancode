import { beforeAll, describe, expect, it } from "vitest";
import { initIgnore, isIgnoreFile } from "./ignore";

describe("ignore", () => {
	beforeAll(() => {
		initIgnore(process.cwd());
	});

	it("should ignore node_modules", () => {
		expect(isIgnoreFile("node_modules/some/file.js")).toBe(true);
	});

	it("should ignore dist directory", () => {
		expect(isIgnoreFile("dist/bundle.js")).toBe(true);
	});

	it("should not ignore normal source files", () => {
		expect(isIgnoreFile("src/index.ts")).toBe(false);
	});

	it("should ignore .git directory", () => {
		expect(isIgnoreFile(".git/config")).toBe(true);
	});

	it("should handle nested paths", () => {
		expect(isIgnoreFile("packages/tools/src/index.ts")).toBe(false);
	});

	it("should ignore build output", () => {
		expect(isIgnoreFile("build/output.js")).toBe(true);
	});

	it("should ignore env files", () => {
		expect(isIgnoreFile(".env")).toBe(true);
		expect(isIgnoreFile(".env.local")).toBe(true);
	});

	it("should ignore .venv directory", () => {
		expect(isIgnoreFile(".venv/bin/python")).toBe(true);
	});

	it("should throw on empty path", () => {
		expect(() => isIgnoreFile("")).toThrow();
	});
});
