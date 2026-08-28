import { describe, expect, it } from "vitest";
import { globFiles } from "./globTool";

describe("globTool", () => {
	it("should find .ts files", async () => {
		const result = await globFiles(process.cwd(), "**/*.ts");
		expect(result.success).toBe(true);
		expect(result.data).toBeTruthy();
		expect(result.data.split("\n").length).toBeGreaterThan(0);
	});

	it("should not fail on empty pattern", async () => {
		const result = await globFiles(process.cwd(), "");
		expect(result.success).toBe(true);
	});

	it("should include duration", async () => {
		const result = await globFiles(process.cwd(), "**/*.ts");
		expect(result.duration).toBeGreaterThan(0);
	});
});
