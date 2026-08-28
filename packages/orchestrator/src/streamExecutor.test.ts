import { ToolManager } from "@xuancode/tools";
import { describe, expect, it } from "vitest";
import { StreamingToolExecutor } from "./streamExecutor";

describe("StreamingToolExecutor", () => {
	it("should create instance", () => {
		const tm = new ToolManager(process.cwd());
		const executor = new StreamingToolExecutor(tm);
		expect(executor).toBeDefined();
	});

	it("should reset state", () => {
		const tm = new ToolManager(process.cwd());
		const executor = new StreamingToolExecutor(tm);
		executor.reset();
		expect(executor.getFirstToolCall()).toBeNull();
	});

	it("should not find tool in empty buffer", () => {
		const tm = new ToolManager(process.cwd());
		const executor = new StreamingToolExecutor(tm);
		expect(executor.getFirstToolCall()).toBeNull();
	});

	it("should detect tool call in buffer", () => {
		const tm = new ToolManager(process.cwd());
		const executor = new StreamingToolExecutor(tm);
		executor.feedChunk('{"type":"list_dir","path":"."}');
		const tc = executor.getFirstToolCall();
		expect(tc).not.toBeNull();
		expect(tc?.type).toBe("list_dir");
	});

	it("should finalize with results", async () => {
		const tm = new ToolManager(process.cwd());
		const executor = new StreamingToolExecutor(tm);
		executor.feedChunk('{"type":"list_dir","path":"."}');
		const results = await executor.finalize();
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].success).toBe(true);
	});
});
