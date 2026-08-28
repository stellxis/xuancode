// ===== Message Protocol Types =====

export type MessageType =
	| "command"
	| "request"
	| "response"
	| "event"
	| "heartbeat";

export interface CommandMessage {
	type: "command";
	command: string;
	payload?: unknown;
	correlationId: string;
	timestamp: number;
}

export interface RequestMessage {
	type: "request";
	method: string;
	params?: unknown;
	correlationId: string;
	timestamp: number;
}

export interface ResponseMessage {
	type: "response";
	correlationId: string;
	success: boolean;
	data?: unknown;
	error?: string;
	timestamp: number;
}

export interface EventMessage {
	type: "event";
	event: string;
	payload?: unknown;
	timestamp: number;
}

export interface HeartbeatMessage {
	type: "heartbeat";
	timestamp: number;
}

export type WorkerMessage =
	| CommandMessage
	| RequestMessage
	| ResponseMessage
	| EventMessage
	| HeartbeatMessage;

// ===== Helper Functions =====

let _correlationSeq = 0;

export function nextCorrelationId(): string {
	return `corr_${Date.now()}_${++_correlationSeq}`;
}

export function createCommand(
	command: string,
	payload?: unknown,
): CommandMessage {
	return {
		type: "command",
		command,
		payload,
		correlationId: nextCorrelationId(),
		timestamp: Date.now(),
	};
}

export function createRequest(
	method: string,
	params?: unknown,
): RequestMessage {
	return {
		type: "request",
		method,
		params,
		correlationId: nextCorrelationId(),
		timestamp: Date.now(),
	};
}

export function createResponse(
	correlationId: string,
	success: boolean,
	data?: unknown,
	error?: string,
): ResponseMessage {
	return {
		type: "response",
		correlationId,
		success,
		data,
		error,
		timestamp: Date.now(),
	};
}

export function createEvent(event: string, payload?: unknown): EventMessage {
	return {
		type: "event",
		event,
		payload,
		timestamp: Date.now(),
	};
}

// ===== Domain Types (shared between units) =====

export interface FileChangeEvent {
	type: "created" | "modified" | "deleted";
	filePath: string;
	timestamp: number;
}

export interface ReconStatus {
	watching: boolean;
	watchedDir: string;
	uptime: number;
}

export interface IntelStatus {
	initialized: boolean;
	uptime: number;
}
