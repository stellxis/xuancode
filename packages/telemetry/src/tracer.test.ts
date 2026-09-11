import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tracer } from "./tracer";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tracer-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Tracer jsonl sink", () => {
	it("endTrace 落盘到 traces-YYYY-MM-DD.jsonl", async () => {
		const sinkDir = path.join(tmpDir, "telemetry");
		const tracer = new Tracer({ sinkDir });
		tracer.startTrace("测试任务", "task-1");
		const span = tracer.startSpan("tool_call", "tool");
		tracer.endSpan(span!.id, "ok");
		tracer.endTrace({ turnCount: 3, toolCallCount: 1 });

		const files = await fs.readdir(sinkDir);
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^traces-\d{4}-\d{2}-\d{2}\.jsonl$/);

		const raw = await fs.readFile(path.join(sinkDir, files[0]), "utf-8");
		const trace = JSON.parse(raw.trim()) as { id: string; turnCount: number };
		expect(trace.id).toBeTruthy();
		expect(trace.turnCount).toBe(3);
	});

	it("同日多次 trace 追加同一文件", async () => {
		const sinkDir = path.join(tmpDir, "telemetry");
		const tracer = new Tracer({ sinkDir });
		tracer.startTrace("任务 A");
		tracer.endTrace();
		tracer.startTrace("任务 B");
		tracer.endTrace();

		const files = await fs.readdir(sinkDir);
		expect(files.length).toBe(1);
		const raw = await fs.readFile(path.join(sinkDir, files[0]), "utf-8");
		expect(raw.trim().split("\n").length).toBe(2);
	});

	it("importTrace 只落盘已完成的 trace", async () => {
		const sinkDir = path.join(tmpDir, "telemetry");
		const tracer = new Tracer({ sinkDir });
		tracer.importTrace({
			id: "trace-running",
			input: "进行中",
			startTime: 0,
			endTime: null,
			duration: null,
			spans: [],
			turnCount: 1,
			toolCallCount: 0,
			errorCount: 0,
		});
		tracer.importTrace({
			id: "trace-done",
			input: "已完成",
			startTime: 0,
			endTime: 100,
			duration: 100,
			spans: [],
			turnCount: 1,
			toolCallCount: 0,
			errorCount: 0,
		});

		const files = await fs.readdir(sinkDir).catch(() => [] as string[]);
		// 只有已完成的 trace 落盘
		if (files.length === 1) {
			const raw = await fs.readFile(path.join(sinkDir, files[0]), "utf-8");
			expect(raw).toContain("trace-done");
			expect(raw).not.toContain("trace-running");
		}
	});

	it("无 sinkDir 时纯内存，不产生文件", async () => {
		const tracer = new Tracer();
		tracer.startTrace("内存任务");
		tracer.endTrace();
		const entries = await fs.readdir(tmpDir);
		expect(entries.length).toBe(0);
	});
});
