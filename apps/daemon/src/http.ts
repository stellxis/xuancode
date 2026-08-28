import type http from "node:http";

/** 统一 JSON 响应 */
export function respond(
	res: http.ServerResponse,
	status: number,
	data: unknown,
): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data, null, 2));
}

export function readBody(req: http.IncomingMessage): Promise<any> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8");
			try {
				resolve(JSON.parse(raw));
			} catch {
				resolve({});
			}
		});
		req.on("error", reject);
	});
}

/** 提取客户端 IP（穿透代理） */
export function getClientIp(req: http.IncomingMessage): string {
	const fwd = req.headers["x-forwarded-for"];
	if (typeof fwd === "string" && fwd.length > 0)
		return fwd.split(",")[0].trim();
	if (Array.isArray(fwd) && fwd.length > 0) return fwd[0].trim();
	return req.socket.remoteAddress || "unknown";
}
