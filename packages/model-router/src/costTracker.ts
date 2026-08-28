import type { CostRecord } from "./types";

/**
 * Cost tracker – record per-request costs and compute aggregates.
 */
export class CostTracker {
	private records: CostRecord[] = [];

	/** Record a completed request's cost */
	record(rec: CostRecord): void {
		this.records.push(rec);
	}

	/** Get all records */
	getAll(): CostRecord[] {
		return this.records;
	}

	/** Get aggregate stats by provider */
	getAggregates(): Array<{
		provider: string;
		model: string;
		totalCost: number;
		totalInputTokens: number;
		totalOutputTokens: number;
		requestCount: number;
		avgLatencyMs: number;
	}> {
		const groups = new Map<
			string,
			{
				count: number;
				totalCost: number;
				totalInput: number;
				totalOutput: number;
				latencies: number[];
			}
		>();

		for (const r of this.records) {
			const key = `${r.provider}::${r.model}`;
			const g = groups.get(key) ?? {
				count: 0,
				totalCost: 0,
				totalInput: 0,
				totalOutput: 0,
				latencies: [],
			};
			g.count++;
			g.totalCost += r.cost;
			g.totalInput += r.inputTokens;
			g.totalOutput += r.outputTokens;
			g.latencies.push(r.latencyMs);
			groups.set(key, g);
		}

		return Array.from(groups.entries()).map(([key, g]) => {
			const [provider, model] = key.split("::");
			return {
				provider,
				model,
				totalCost: g.totalCost,
				totalInputTokens: g.totalInput,
				totalOutputTokens: g.totalOutput,
				requestCount: g.count,
				avgLatencyMs:
					g.latencies.reduce((a, b) => a + b, 0) / g.latencies.length,
			};
		});
	}

	/** Reset all records */
	reset(): void {
		this.records = [];
	}

	/** Get total cost across all records */
	get totalCost(): number {
		return this.records.reduce((sum, r) => sum + r.cost, 0);
	}
}
