import type {
	CompactEntry,
	ErrorEntry,
	LogEntry,
	MessageEntry,
	SessionEndEntry,
	SessionMeta,
	ToolCallEntry,
} from "@xuancode/session";

/** 将 JSONL LogEntry 转为 sessions 表列数据 */
export function entryToSessionRow(
	meta: SessionMeta,
	end?: SessionEndEntry,
	extra?: { userId?: string; workspaceId?: string },
): {
	id: string;
	user_id: string | null;
	workspace_id: string | null;
	status: string;
	created_at: string;
	completed_at: string | null;
	user_input: string;
	config_json: string;
	turn_count: number;
	tool_call_count: number;
	error_count: number;
	stop_reason: string | null;
	duration_ms: number | null;
	final_answer: string | null;
	context_usage: number | null;
} {
	return {
		id: meta.sessionId,
		user_id: extra?.userId ?? null,
		workspace_id: extra?.workspaceId ?? null,
		status: end ? "completed" : "active",
		created_at: meta.createdAt,
		completed_at: end ? new Date(Date.now()).toISOString() : null,
		user_input: meta.userInput,
		config_json: JSON.stringify(meta.config),
		turn_count: end?.turnCount ?? 0,
		tool_call_count: end?.toolCallCount ?? 0,
		error_count: end?.errorCount ?? 0,
		stop_reason: end?.stopReason ?? null,
		duration_ms: end?.duration ?? null,
		final_answer: end?.finalAnswer ?? null,
		context_usage: end?.contextUsage ?? null,
	};
}

/** 将 MessageEntry 转为 messages 表列数据 */
export function entryToMessageRow(
	entry: MessageEntry,
	sessionId: string,
): {
	session_id: string;
	turn: number;
	role: string;
	content: string | null;
	tool_call_id: string | null;
	name: string | null;
	created_at: string;
} {
	return {
		session_id: sessionId,
		turn: entry.turn,
		role: entry.message.role,
		content: entry.message.content,
		tool_call_id: entry.message.tool_call_id ?? null,
		name: entry.message.name ?? null,
		created_at: new Date().toISOString(),
	};
}

/** 将 ToolCallEntry 转为 tool_calls 表列数据 */
export function entryToToolCallRow(
	entry: ToolCallEntry,
	sessionId: string,
): {
	session_id: string;
	turn: number;
	tool_type: string;
	args_json: string;
	success: number;
	result_data: string | null;
	result_error: string | null;
	duration_ms: number | null;
	created_at: string;
} {
	return {
		session_id: sessionId,
		turn: entry.turn,
		tool_type: entry.toolCall.type,
		args_json: JSON.stringify(entry.toolCall),
		success: entry.result.success ? 1 : 0,
		result_data: entry.result.data ?? null,
		result_error: entry.result.error ?? null,
		duration_ms: entry.result.duration ?? null,
		created_at: new Date().toISOString(),
	};
}

/** 将 ErrorEntry 转为 errors 表列数据 */
export function entryToErrorRow(
	entry: ErrorEntry,
	sessionId: string,
): {
	session_id: string;
	turn: number;
	site: string;
	message: string;
	recoverable: number;
	created_at: string;
} {
	return {
		session_id: sessionId,
		turn: entry.turn,
		site: entry.site,
		message: entry.message,
		recoverable: entry.recoverable ? 1 : 0,
		created_at: new Date().toISOString(),
	};
}

/** 从 LogEntry 数组中分类提取各类型条目 */
export function classifyEntries(entries: LogEntry[]): {
	meta: SessionMeta | undefined;
	end: SessionEndEntry | undefined;
	messages: MessageEntry[];
	toolCalls: ToolCallEntry[];
	errors: ErrorEntry[];
	compactions: CompactEntry[];
} {
	return {
		meta: entries.find((e): e is SessionMeta => e.type === "session_meta"),
		end: entries.find((e): e is SessionEndEntry => e.type === "session_end"),
		messages: entries.filter((e): e is MessageEntry => e.type === "message"),
		toolCalls: entries.filter(
			(e): e is ToolCallEntry => e.type === "tool_call",
		),
		errors: entries.filter((e): e is ErrorEntry => e.type === "error"),
		compactions: entries.filter((e): e is CompactEntry => e.type === "compact"),
	};
}
