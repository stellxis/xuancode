import type { ErrorEntry, LogEntry, ToolCallEntry } from "@xuancode/session";
import type {
	AgentTrace,
	SpeedrunPattern,
	TraceSpan,
} from "@xuancode/telemetry";

// ===== Pattern Types =====

export type PatternCategory =
	| "excessive_reads"
	| "long_model_calls"
	| "frequent_compaction"
	| "error_spike"
	| "tool_failure_rate"
	| "recovery_exhaustion"
	| "cost_inefficiency"
	| "context_underuse"
	| "tool_sequence_inefficiency";

export interface FailurePattern {
	category: PatternCategory;
	severity: "high" | "medium" | "low";
	score: number;
	description: string;
	occurrences: number;
	traceIds: string[];
	sampleSpanIds: string[];
	recommendation: string;
	autoFixAvailable: boolean;
	suggestedPromptFragment?: string;
	suggestedConfigChange?: Record<string, unknown>;
}

export interface OptimizationSuggestion {
	id: string;
	timestamp: number;
	traceId?: string;
	sessionId?: string;
	patterns: FailurePattern[];
	overallScore: number;
	summary: string;
}

export interface TrendPoint {
	date: string;
	avgScore: number;
	sessionCount: number;
}

export interface TrendReport {
	sessionCount: number;
	timeRange: { from: string; to: string };
	scoreTrend: TrendPoint[];
	topFailures: {
		category: PatternCategory;
		count: number;
		trend: "up" | "down" | "stable";
	}[];
	suggestions: OptimizationSuggestion[];
}

export interface CrossSessionTrend {
	avgDuration: number;
	avgTurnCount: number;
	avgErrorCount: number;
	avgToolCallCount: number;
	avgContextUsage: number;
}

export interface ToolUsageStats {
	toolType: string;
	callCount: number;
	failureCount: number;
	failureRate: number;
	avgDuration: number;
}

// ===== Analyzer Result Types =====

export interface TraceAnalysisResult {
	trace: AgentTrace;
	speedrunPatterns: SpeedrunPattern[];
	failurePatterns: FailurePattern[];
	suggestion: OptimizationSuggestion;
}

// ===== Element-to-Category Mapping =====

export const TOOL_KIND_MAP: Record<string, string> = {
	read_file: "wood",
	read_directory: "wood",
	glob: "wood",
	grep: "wood",
	write_file: "metal",
	edit_file: "metal",
	delete_file: "metal",
	create_directory: "metal",
	bash: "fire",
	execute_command: "fire",
	web_search: "water",
	web_fetch: "water",
	thinking: "earth",
	analyze: "earth",
	plan: "earth",
};
