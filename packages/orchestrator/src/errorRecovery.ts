import { type AgentState, StopReason, type ToolResult } from "@xuancode/types";

/**
 * 7 continue sites — graceful degradation at each failure point
 *
 * Claude Code uses 7 continue points in the query loop. Each represents
 * a specific failure mode with a recovery strategy.
 */

export enum ContinueSite {
	/** Site 1: Model API call failed (network, auth, rate limit) */
	MODEL_CALL = "model_call",
	/** Site 2: Model returned empty/invalid response */
	EMPTY_RESPONSE = "empty_response",
	/** Site 3: Tool call parse failed */
	TOOL_PARSE = "tool_parse",
	/** Site 4: Tool execution threw an exception */
	TOOL_EXECUTION = "tool_execution",
	/** Site 5: Tool returned error result */
	TOOL_ERROR = "tool_error",
	/** Site 6: Context compaction failed */
	COMPACT_FAILURE = "compact_failure",
	/** Site 7: Permission check hung or denied */
	PERMISSION_HUNG = "permission_hung",
}

export interface RecoveryAction {
	/** Should we continue the loop? */
	shouldContinue: boolean;
	/** Message to inject explaining recovery */
	recoveryMessage?: string;
	/** Stop reason if we cannot recover */
	stopReason?: StopReason;
	/** Should we reduce turn budget? */
	penalizeTurn?: boolean;
}

export type RecoveryStrategy = (
	state: AgentState,
	error: Error | string,
) => RecoveryAction;

/**
 * Recovery strategies for each continue site
 */
const RECOVERY_STRATEGIES: Record<ContinueSite, RecoveryStrategy> = {
	[ContinueSite.MODEL_CALL]: (state, error) => {
		state.consecutiveErrors++;
		const errStr = typeof error === "string" ? error : error.message;
		const isAuthError =
			errStr.includes("401") ||
			errStr.includes("403") ||
			errStr.includes("API key") ||
			errStr.includes("unauthorized") ||
			errStr.includes("Unauthorized");
		if (state.consecutiveErrors >= 3) {
			const hint = isAuthError
				? "模型连续调用失败,请检查设置中的 API 密钥是否正确配置"
				: "模型连续调用失败,终止执行";
			return {
				shouldContinue: false,
				stopReason: StopReason.ERROR,
				recoveryMessage: hint,
			};
		}
		const retryMsg = isAuthError
			? "(API 认证失败,请在设置中配置正确的 API 密钥)"
			: "(模型调用异常,玄码自动重试中...)";
		return {
			shouldContinue: true,
			recoveryMessage: retryMsg,
		};
	},

	[ContinueSite.EMPTY_RESPONSE]: (state, _error) => {
		// 推理模型（如 DeepSeek）常把回答/工具调用留在推理标签内导致内容被剥离成空响应。
		// 给模型 2 次注入提示自纠的机会，连续 3 次空响应才终止。
		// consecutiveErrors 由调用方在进入本策略前通过 addError 累加。
		if (state.consecutiveErrors >= 3) {
			return {
				shouldContinue: false,
				stopReason: StopReason.ERROR,
				recoveryMessage: "模型连续返回空响应,终止执行",
			};
		}
		return {
			shouldContinue: true,
			recoveryMessage:
				"(模型输出为空,请直接输出对用户有用的回答或调用工具来解决问题,不要只输出推理标签)",
		};
	},

	[ContinueSite.TOOL_PARSE]: (state, error) => {
		// Model may be responding directly (not a tool call)
		const lastMsg = state.messages[state.messages.length - 1];
		if (lastMsg?.role === "assistant" && lastMsg.content.length > 10) {
			return {
				shouldContinue: false,
				stopReason: StopReason.NO_TOOL_USE,
				recoveryMessage: undefined,
			};
		}
		// Garbled response — inject parse error and continue
		state.consecutiveErrors++;
		if (state.consecutiveErrors >= 2) {
			return {
				shouldContinue: false,
				stopReason: StopReason.ERROR,
				recoveryMessage: "无法解析模型响应",
			};
		}
		return {
			shouldContinue: true,
			recoveryMessage: `(解析工具调用失败: ${typeof error === "string" ? error : error.message}, 请重新输出工具调用)`,
		};
	},

	[ContinueSite.TOOL_EXECUTION]: (state, error) => {
		state.consecutiveErrors++;
		return {
			shouldContinue: state.consecutiveErrors < 3,
			recoveryMessage: `(工具执行异常: ${typeof error === "string" ? error : error.message})`,
			stopReason: state.consecutiveErrors >= 3 ? StopReason.ERROR : undefined,
		};
	},

	[ContinueSite.TOOL_ERROR]: (state, error) => {
		// Tool returned success=false — model can handle this
		return {
			shouldContinue: true,
			recoveryMessage: undefined, // The tool result message is already in the conversation
		};
	},

	[ContinueSite.COMPACT_FAILURE]: (_state, _error) => {
		// Compaction failure is non-fatal — skip compaction and continue
		return {
			shouldContinue: true,
			recoveryMessage: "(上下文压缩失败,跳过本轮压缩)",
		};
	},

	[ContinueSite.PERMISSION_HUNG]: (_state, _error) => {
		return {
			shouldContinue: false,
			stopReason: StopReason.ABORT,
			recoveryMessage: "权限确认超时,已终止操作",
		};
	},
};

/**
 * Get recovery action for a given continue site
 */
export function getRecovery(
	site: ContinueSite,
	state: AgentState,
	error: Error | string,
): RecoveryAction {
	const strategy = RECOVERY_STRATEGIES[site];
	const action = strategy(state, error);
	return action;
}

/**
 * Check if error is recoverable
 */
export function isRecoverable(site: ContinueSite, state: AgentState): boolean {
	const action = getRecovery(site, state, "check");
	return action.shouldContinue;
}
