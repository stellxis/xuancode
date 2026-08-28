/**
 * @xuancode/mcp-server — MCP 协议服务端
 *
 * 将玄码的 ToolManager 工具暴露为标准 MCP 协议，
 * 供 Claude Desktop、VS Code 等 MCP 客户端调用。
 *
 * ## 使用方式
 *
 * ```ts
 * import { MCPServer, createMCPHttpHandler, SSETransport } from "@xuancode/mcp-server";
 * import { ToolManager } from "@xuancode/tools";
 *
 * const toolManager = new ToolManager("/path/to/workdir");
 * const mcp = new MCPServer(toolManager);
 *
 * // SSE 连接到达时，创建传输并注册到 MCP Server
 * function onSSEConnection(sessionId: string, sseRes: ServerResponse) {
 *   const transport = new SSETransport();
 *   transport.attachSSEResponse(sseRes);
 *   mcp.createSession(transport);
 *   return transport;
 * }
 *
 * // POST /message 到达时，转发到对应传输
 * function onMessage(sessionId: string, body: unknown) {
 *   const transport = sessions.get(sessionId);
 *   transport?.handlePOST(body);
 * }
 * ```
 */

export { MCPServer } from "./server.js";
export type { MCPServerOptions } from "./server.js";

export { SSETransport, createMCPHttpHandler } from "./sseTransport.js";
export type { SSETransportOptions } from "./sseTransport.js";

export { StdioTransport } from "./stdioTransport.js";

export { MCPToolRegistry } from "./toolRegistry.js";

export * from "./types.js";
