/**
 * @xuancode/a2a — Agent-to-Agent 协议实现
 *
 * 遵循 Google Agent-to-Agent (A2A) 协议规范，
 * 提供 Agent 发现、任务提交与结果获取能力。
 *
 * ## 使用方式
 *
 * ```ts
 * import { A2AServer } from "@xuancode/a2a";
 * import { ToolManager } from "@xuancode/tools";
 *
 * const toolManager = new ToolManager("/path/to/workdir");
 * const a2a = new A2AServer(toolManager);
 *
 * // 在 HTTP 服务器中
 * if (!a2a.handleRequest(req, res)) {
 *   // 非 A2A 请求，继续其他路由
 * }
 * ```
 */

export { A2AServer } from "./server.js";
export type { A2AServerOptions } from "./server.js";

export { generateAgentCard } from "./card.js";

export * from "./types.js";
