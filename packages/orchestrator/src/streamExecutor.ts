import type { ToolManager } from "@xuancode/tools";
import type { ToolCallParams, ToolResult } from "@xuancode/types";
import { parseToolCall } from "./toolParser";

/**
 * StreamingToolExecutor — begins executing tools as they stream in
 *
 * In Claude Code's architecture, tools can begin executing before the model
 * finishes streaming its response. This reduces latency significantly.
 */
export class StreamingToolExecutor {
	private toolManager: ToolManager;
	private buffer = "";
	private toolCalls: ToolCallParams[] = [];
	private results: ToolResult[] = [];
	private isExecuting = false;
	private resolveQueue: Array<() => void> = [];

	constructor(toolManager: ToolManager) {
		this.toolManager = toolManager;
	}

	/**
	 * Feed a chunk of streaming response — will detect and execute tools eagerly
	 */
	feedChunk(chunk: string): {
		completedTools: ToolResult[];
		pendingBuffer: string;
	} {
		this.buffer += chunk;

		// Try to extract complete JSON tool calls
		const extracted = this.extractToolCalls();
		if (extracted.length > 0) {
			this.toolCalls.push(...extracted);
			// Eagerly execute the first tool call
			this.executeNext();
		}

		return {
			completedTools: [...this.results],
			pendingBuffer: this.buffer,
		};
	}

	/**
	 * Finalize — execute remaining tool calls and get all results
	 */
	async finalize(): Promise<ToolResult[]> {
		// Execute all remaining tool calls sequentially
		for (const tc of this.toolCalls) {
			if (!this.wasExecuted(tc)) {
				try {
					const result = await this.toolManager.dispatch(tc);
					this.results.push(result);
				} catch (err: any) {
					this.results.push({ success: false, data: "", error: err.message });
				}
			}
		}
		return this.results;
	}

	/**
	 * Get first tool call found (non-streaming compatibility)
	 */
	getFirstToolCall(): ToolCallParams | null {
		return this.toolCalls.length > 0 ? this.toolCalls[0] : null;
	}

	/**
	 * Reset for a new turn
	 */
	reset(): void {
		this.buffer = "";
		this.toolCalls = [];
		this.results = [];
		this.isExecuting = false;
	}

	private wasExecuted(tc: ToolCallParams): boolean {
		// Simple check: match by type and path/command
		return this.results.some(
			(r) =>
				r.data.includes(tc.path || "") || r.data.includes(tc.command || ""),
		);
	}

	private extractToolCalls(): ToolCallParams[] {
		const calls: ToolCallParams[] = [];

		// Try parsing incremental buffer as JSON
		const tc = parseToolCall(this.buffer);
		if (
			tc &&
			!this.toolCalls.some(
				(existing) => existing.type === tc.type && existing.path === tc.path,
			)
		) {
			calls.push(tc);
		}

		return calls;
	}

	private async executeNext(): Promise<void> {
		if (this.isExecuting) return;
		this.isExecuting = true;

		try {
			const tc = this.toolCalls[this.toolCalls.length - 1];
			if (tc && !this.results.some((r) => r.data.includes(tc.path || ""))) {
				const result = await this.toolManager.dispatch(tc);
				this.results.push(result);
			}
		} catch (err: any) {
			this.results.push({ success: false, data: "", error: err.message });
		} finally {
			this.isExecuting = false;
		}
	}
}
