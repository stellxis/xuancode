/**
 * 玄码 HookBridge — 将 orchestrator 的 HookEvent 映射到 PluginEvent
 *
 * 避免 orchestrator 与 plugin 包之间的环形依赖。
 * 由 caller（如 daemon）在创建 runTaorLoop 选项时注入。
 */

import type { PluginEvent, PluginRegistry } from "./index";

/**
 * HookEvent → PluginEvent 映射表
 *
 * orchestrator 的 HookEvent 枚举值 → PluginEvent 事件名
 */
const HOOK_TO_PLUGIN_EVENT: Record<string, PluginEvent> = {
	PreToolUse: "onToolCall",
	PostToolUse: "onToolResult",
	PostToolUseFailure: "onError",
	SessionStart: "onSessionStart",
	SessionEnd: "onSessionEnd",
	PermissionDenied: "onError",
};

/**
 * 创建 HookBridge — 返回一个 onHook 回调，可直接传给 runTaorLoop 的 options
 *
 * @example
 * ```ts
 * import { createHookBridge } from "@xuancode/plugins";
 *
 * const onHook = createHookBridge(pluginRegistry);
 * const result = await runTaorLoop(input, { ..., onHook });
 * ```
 */
export function createHookBridge(
	registry: PluginRegistry,
): (event: string, context: Record<string, unknown>) => void {
	return (event: string, context: Record<string, unknown>) => {
		const pluginEvent = HOOK_TO_PLUGIN_EVENT[event];
		if (!pluginEvent) return; // 无对应 PluginEvent，跳过

		registry.emitEvent(pluginEvent, context).catch((err) => {
			console.error(
				`[HookBridge] 事件 ${event} → ${pluginEvent} 处理失败:`,
				err,
			);
		});
	};
}

/**
 * 获取支持的事件映射列表（用于诊断/调试）
 */
export function getHookEventMappings(): Array<{
	hookEvent: string;
	pluginEvent: PluginEvent;
}> {
	return Object.entries(HOOK_TO_PLUGIN_EVENT).map(
		([hookEvent, pluginEvent]) => ({
			hookEvent,
			pluginEvent,
		}),
	);
}
