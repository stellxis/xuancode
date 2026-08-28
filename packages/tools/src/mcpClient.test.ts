import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	JSONRPCRequest,
	JSONRPCResponse,
	MCPTransport,
} from "./mcpClient";
import { ToolManager } from "./toolManager";

const TEST_DIR = path.join(process.cwd(), ".test-mcptmp");

// ===== Mock Transport for unit testing =====

class MockTransport implements MCPTransport {
	private responses: Map<string, any> = new Map();
	private closed = false;

	constructor() {
		this.responses.set("initialize", {
			serverInfo: { name: "mock-server", version: "1.0.0" },
		});
		this.responses.set("tools/list", {
			tools: [
				{
					name: "mock_greet",
					description: "Mock 问候工具",
					inputSchema: {
						type: "object",
						properties: { name: { type: "string", description: "名字" } },
						required: ["name"],
					},
				},
				{
					name: "mock_echo",
					description: "Mock 回显工具",
					inputSchema: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
					},
				},
			],
		});
		this.responses.set("tools/call", {
			content: [{ type: "text", text: "Hello from mock!" }],
		});
	}

	async connect(): Promise<void> {
		this.closed = false;
	}
	async send(message: JSONRPCRequest): Promise<JSONRPCResponse> {
		const result = this.responses.get(message.method) || {};
		if (
			message.method === "tools/call" &&
			message.params?.name === "mock_greet"
		) {
			return {
				jsonrpc: "2.0",
				id: message.id!,
				result: {
					content: [
						{
							type: "text",
							text: `Hello, ${(message.params?.arguments as any)?.name || "world"}!`,
						},
					],
				},
			};
		}
		return { jsonrpc: "2.0", id: message.id, result };
	}
	async close(): Promise<void> {
		this.closed = true;
	}
	isClosed(): boolean {
		return this.closed;
	}
}

// ===== Tests =====

describe("MCPClient with MockTransport", () => {
	let MCPClient: any;

	beforeAll(async () => {
		const mod = await import("./mcpClient");
		MCPClient = mod.MCPClient;
	});

	it("should connect and list tools", async () => {
		const client = new MCPClient(new MockTransport());
		await client.connect();
		const tools = await client.listTools();
		expect(tools).toHaveLength(2);
		expect(tools[0].name).toBe("mock_greet");
		await client.close();
	});

	it("should call tools", async () => {
		const client = new MCPClient(new MockTransport());
		await client.connect();
		const result = await client.callTool("mock_greet", { name: "玄码" });
		expect(result.content[0].text).toBe("Hello, 玄码!");
		await client.close();
	});

	it("should fail before initialization", async () => {
		const client = new MCPClient(new MockTransport());
		await expect(client.listTools()).rejects.toThrow("未初始化");
	});

	it("should get server info", async () => {
		const client = new MCPClient(new MockTransport());
		await client.connect();
		const info = client.getServerInfo();
		expect(info.name).toBe("mock-server");
		await client.close();
	});
});

describe("ToolManager MCP integration", () => {
	let MCPClient: any;

	beforeAll(async () => {
		const mod = await import("./mcpClient");
		MCPClient = mod.MCPClient;
	});

	it("should register MCP tools via connectMCP", async () => {
		const client = new MCPClient(new MockTransport());
		const tm = new ToolManager(TEST_DIR);
		const result = await tm.connectMCP(client);

		expect(result.serverName).toBe("mock-server");
		expect(result.toolsAdded).toBe(2);

		const defs = tm.getDefinitions();
		const mcpDefs = defs.filter((d) => d.type.startsWith("mcp_"));
		expect(mcpDefs).toHaveLength(2);
		expect(mcpDefs[0].name).toBe("mock_greet");

		await client.close();
	});

	it("should dispatch MCP tools via ToolManager", async () => {
		const client = new MCPClient(new MockTransport());
		const tm = new ToolManager(TEST_DIR);
		await tm.connectMCP(client);

		const result = await tm.dispatch({
			type: "mcp_mock_greet",
			name: "玄码",
		} as any);
		expect(result.success).toBe(true);
		expect(result.data).toContain("Hello");

		await client.close();
	});

	it("should include MCP tools in generated prompt", async () => {
		const client = new MCPClient(new MockTransport());
		const tm = new ToolManager(TEST_DIR);
		await tm.connectMCP(client);

		const prompt = tm.generateToolPrompt();
		expect(prompt).toContain("mock_greet");
		expect(prompt).toContain("Mock 问候工具");

		await client.close();
	});
});

describe("MCPClient StdioTransport integration", () => {
	let MCPClientType: any;
	let StdioTransportType: any;
	const scriptPath = path.join(TEST_DIR, "mcp-test-server.cjs");

	beforeAll(async () => {
		const mod = await import("./mcpClient");
		MCPClientType = mod.MCPClient;
		StdioTransportType = mod.StdioTransport;

		if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
		// Write a CommonJS script (will not be affected by "type":"module")
		fs.writeFileSync(
			scriptPath,
			`
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "stdio-test", version: "1.0.0" } } }));
  } else if (msg.method === "tools/list") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "stdio_greet", description: "Stdio 测试工具", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }
    ]}}));
  } else if (msg.method === "tools/call") {
    const args = msg.params.arguments || {};
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Hi, " + args.name + "!" }] } }));
  } else if (msg.method === "shutdown") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    process.exit(0);
  }
});
`.trim(),
		);
	});

	afterAll(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("should connect via stdio and list tools", async () => {
		const transport = new StdioTransportType("node", [scriptPath]);
		const client = new MCPClientType(transport);
		await client.connect();
		const tools = await client.listTools();
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("stdio_greet");
		await client.close();
	});

	it("should call tools via stdio", async () => {
		const transport = new StdioTransportType("node", [scriptPath]);
		const client = new MCPClientType(transport);
		await client.connect();
		const result = await client.callTool("stdio_greet", { name: "玄码" });
		expect(result.content[0].text).toBe("Hi, 玄码!");
		await client.close();
	});
});

describe("HttpTransport", () => {
	let HttpTransportType: any;

	beforeAll(async () => {
		const mod = await import("./mcpClient");
		HttpTransportType = mod.HttpTransport;
	});

	it("should construct and connect", async () => {
		const transport = new HttpTransportType("https://mcp.example.com");
		await transport.connect();
		await transport.close();
	});
});
