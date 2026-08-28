import http from "node:http";
import { API_VERSION_HEADER } from "@xuancode/daemon-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "./daemonClient";

const servers: http.Server[] = [];

function startMockDaemon(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		servers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as any;
			resolve(`http://127.0.0.1:${addr.port}`);
		});
	});
}

afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

describe("DaemonClient 协议版本协商", () => {
	it("getVersion 请求携带 X-XC-Api-Version header", async () => {
		let seenHeader: string | undefined;
		const baseUrl = await startMockDaemon((req, res) => {
			seenHeader = req.headers[API_VERSION_HEADER.toLowerCase()] as
				| string
				| undefined;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					protocol: "xuancode-daemon",
					apiVersion: 1,
					daemonVersion: "0.1.0",
					features: [],
				}),
			);
		});
		const client = new DaemonClient({ baseUrl });
		const info = await client.getVersion();
		expect(info.apiVersion).toBe(1);
		expect(seenHeader).toBe("1");
	});

	it("版本一致 → ok", async () => {
		const baseUrl = await startMockDaemon((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					protocol: "xuancode-daemon",
					apiVersion: 1,
					daemonVersion: "0.1.0",
					features: [],
				}),
			);
		});
		const client = new DaemonClient({ baseUrl });
		const compat = await client.ensureCompatible();
		expect(compat.ok).toBe(true);
		expect(compat.needsUpgrade).toBeNull();
		expect(compat.daemonVersion).toBe("0.1.0");
	});

	it("daemon 协议更新 → 客户端需升级", async () => {
		const baseUrl = await startMockDaemon((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					protocol: "xuancode-daemon",
					apiVersion: 2,
					daemonVersion: "0.2.0",
					features: [],
				}),
			);
		});
		const client = new DaemonClient({ baseUrl });
		const compat = await client.ensureCompatible();
		expect(compat.ok).toBe(false);
		expect(compat.needsUpgrade).toBe("client");
	});

	it("daemon 协议过旧 → daemon 需升级", async () => {
		const baseUrl = await startMockDaemon((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					protocol: "xuancode-daemon",
					apiVersion: 0,
					daemonVersion: "0.0.9",
					features: [],
				}),
			);
		});
		const client = new DaemonClient({ baseUrl });
		const compat = await client.ensureCompatible();
		expect(compat.ok).toBe(false);
		expect(compat.needsUpgrade).toBe("daemon");
	});

	it("旧 daemon 无 /version → 优雅降级为 v1，不阻塞", async () => {
		const baseUrl = await startMockDaemon((req, res) => {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "未找到路由" }));
		});
		const client = new DaemonClient({ baseUrl });
		const compat = await client.ensureCompatible();
		expect(compat.ok).toBe(true);
		expect(compat.needsUpgrade).toBeNull();
	});
});
