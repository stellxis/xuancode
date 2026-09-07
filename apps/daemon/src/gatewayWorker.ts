/**
 * 玄码 Gateway Worker — BullMQ Worker 模块
 *
 * 三层安全防护：
 * 1. Provider Key 从 PG 加密存储中读取，解密后只在当前 Job 作用域内存在
 * 2. 使用 process.env 临时注入（适配器通过 process.env[KEY] 读取），Job 完成后立即清除
 * 3. 每次调用记录审计日志（userId / model / token / 成本）
 */

import type { ModelRouter } from "@xuancode/model-router";
import type { Message } from "@xuancode/types";
import { Worker } from "bullmq";
import Redis from "ioredis";

interface LlmJobData {
	type: "chat" | "chat-stream";
	userId: string;
	plan: string;
	model: string;
	messages: Message[];
	systemPrompt?: string;
	tools?: any[];
	stream: boolean;
	reasoningLevel?: "fast" | "medium" | "expert";
}

interface ProviderKeyCache {
	[provider: string]: {
		apiKey: string;
		baseUrl: string | null;
	};
}

export function createGatewayWorker(
	modelRouter: ModelRouter,
	redisUrl: string,
	opts?: { databaseUrl?: string },
): Worker {
	const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
	const publisher = new Redis(redisUrl);

	// In-memory provider key cache (populated once on startup, NOT in process.env)
	let keyCache: ProviderKeyCache = {};

	// Load provider keys from PG on startup (decrypted in memory only)
	if (opts?.databaseUrl) {
		loadKeyCache(opts.databaseUrl)
			.then((cache) => {
				keyCache = cache;
				console.error(
					`[GatewayWorker] Loaded ${Object.keys(cache).length} provider keys into memory cache`,
				);
			})
			.catch((err) => {
				console.error("[GatewayWorker] Failed to load provider keys:", err);
			});
	}

	const worker = new Worker<LlmJobData>(
		"llm-requests",
		async (job) => {
			const {
				model,
				messages,
				systemPrompt,
				tools,
				stream,
				userId,
				reasoningLevel,
			} = job.data;

			console.error(
				`[GatewayWorker] processing job ${job.id} (model=${model}, stream=${stream}, userId=${userId})`,
			);

			// Determine provider from model name
			const provider = resolveProvider(model);
			const keyEntry = keyCache[provider];

			// ─── Layer 2: Per-Job env injection ──────────────────
			// Temporarily set process.env so adapters can read it.
			// Cleared immediately after the job completes.
			const prevKeys: Record<string, string | undefined> = {};
			if (keyEntry?.apiKey) {
				const upper = provider.toUpperCase();
				const envKey = `${upper}_API_KEY`;
				prevKeys[envKey] = process.env[envKey];
				process.env[envKey] = keyEntry.apiKey;

				// Backward-compatible aliases
				const aliasMap: Record<string, string> = {
					deepseek: "DEEPSEEK_API_KEY",
					openai: "OPENAI_API_KEY",
					anthropic: "ANTHROPIC_API_KEY",
					google: "GOOGLE_API_KEY",
					zhipu: "ZHIPU_API_KEY",
					volcengine: "VOLC_API_KEY",
				};
				if (aliasMap[provider]) {
					prevKeys[aliasMap[provider]] = process.env[aliasMap[provider]];
					process.env[aliasMap[provider]] = keyEntry.apiKey;
				}
			}

			try {
				modelRouter.setProvider(provider, model);
				if (reasoningLevel) modelRouter.setReasoningLevel(reasoningLevel);

				if (stream) {
					const channel = `job:${job.id}:stream`;
					let tokenCount = 0;

					for await (const token of modelRouter.chatStream(
						messages,
						systemPrompt,
						tools,
					)) {
						await publisher.publish(
							channel,
							JSON.stringify({ type: "chunk", data: token }),
						);
						tokenCount++;
					}

					await publisher.publish(channel, JSON.stringify({ type: "done" }));
					console.error(
						`[GatewayWorker] job ${job.id} complete (${tokenCount} tokens)`,
					);

					// Layer 3: Audit log
					logAudit(job.id ?? "unknown", userId, provider, model, tokenCount);

					return { tokens: tokenCount, success: true };
				}
				const result = await modelRouter.chat(messages, systemPrompt, tools);

				// Layer 3: Audit log (estimate tokens from result length)
				const estimatedTokens = Math.ceil(result.length / 2);
				logAudit(job.id ?? "unknown", userId, provider, model, estimatedTokens);

				return { result, success: true };
			} catch (err: any) {
				console.error(`[GatewayWorker] job ${job.id} error:`, err);
				if (stream) {
					await publisher.publish(
						`job:${job.id}:stream`,
						JSON.stringify({ type: "error", error: err.message }),
					);
				}
				throw err;
			} finally {
				// ─── Layer 2 cleanup: Restore process.env ─────────
				for (const [key, val] of Object.entries(prevKeys)) {
					if (val === undefined) {
						delete process.env[key];
					} else {
						process.env[key] = val;
					}
				}
			}
		},
		{
			connection,
			concurrency: 4,
			limiter: {
				max: 60,
				duration: 1000,
			},
		},
	);

	worker.on("completed", (job) => {
		console.error(`[GatewayWorker] job ${job.id} completed`);
	});

	worker.on("failed", (job, err) => {
		console.error(`[GatewayWorker] job ${job?.id} failed:`, err.message);
	});

	return worker;
}

// ─── Provider key loader (Layer 1) ────────────────────────

async function loadKeyCache(databaseUrl: string): Promise<ProviderKeyCache> {
	const pg = await import("pg");
	const pool = new pg.default.Pool({ connectionString: databaseUrl, max: 2 });
	try {
		const result = await pool.query(
			"SELECT provider, api_key, base_url FROM provider_keys WHERE is_active = true",
		);
		const cache: ProviderKeyCache = {};
		for (const row of result.rows) {
			// Key is AES-256-GCM encrypted; decrypt in memory
			cache[row.provider] = {
				apiKey: decryptKey(row.api_key),
				baseUrl: row.base_url,
			};
		}
		return cache;
	} finally {
		await pool.end();
	}
}

/** AES-256-GCM decrypt (must match gateway/src/providerKeyStore.ts) */
function decryptKey(ciphertext: string): string {
	const keyHex = process.env.PROVIDER_KEY_ENCRYPTION_KEY;
	if (!keyHex || keyHex.length !== 64) return ciphertext; // no key → plaintext

	const parts = ciphertext.split(":");
	if (parts.length !== 3) return ciphertext; // not encrypted → plaintext

	const crypto = require("node:crypto") as typeof import("node:crypto");
	const [ivHex, authTagHex, encryptedHex] = parts;
	try {
		const key = Buffer.from(keyHex, "hex");
		const decipher = crypto.createDecipheriv(
			"aes-256-gcm",
			key,
			Buffer.from(ivHex, "hex"),
		);
		decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
		return (
			decipher.update(encryptedHex, "hex", "utf-8") + decipher.final("utf-8")
		);
	} catch {
		return ciphertext;
	}
}

// ─── Audit logging (Layer 3) ──────────────────────────────

interface AuditEntry {
	jobId: string;
	userId: string;
	provider: string;
	model: string;
	tokens: number;
	estimatedCost: number;
	timestamp: string;
}

/** Model pricing per 1K tokens (input cost, used for rough cost estimation) */
const MODEL_COST_PER_1K: Record<string, number> = {
	"deepseek-chat": 0.0005,
	"deepseek-reasoner": 0.001,
	"deepseek-v4-flash": 0.0003,
	"gpt-4o-mini": 0.0015,
	"gpt-4o": 0.0025,
	"o3-mini": 0.0011,
	"claude-sonnet-4-20250514": 0.003,
	"claude-haiku-3-5": 0.001,
	"gemini-2.0-flash": 0.0001,
	"gemini-2.5-pro": 0.00125,
	"glm-4-plus": 0.001,
	"glm-4-flash": 0.0002,
	"doubao-1.5-pro": 0.0008,
	"doubao-1.5-lite": 0.0003,
};

function logAudit(
	jobId: string,
	userId: string,
	provider: string,
	model: string,
	tokens: number,
): void {
	const costPer1K = MODEL_COST_PER_1K[model] ?? 0.001;
	const estimatedCost = (tokens / 1000) * costPer1K;

	const entry: AuditEntry = {
		jobId,
		userId,
		provider,
		model,
		tokens,
		estimatedCost: Math.round(estimatedCost * 100000) / 100000,
		timestamp: new Date().toISOString(),
	};

	// Structured JSON log (can be shipped to log aggregator)
	console.log(JSON.stringify({ type: "audit", ...entry }));
}

// ─── Helpers ──────────────────────────────────────────────

function resolveProvider(model: string): string {
	const prefixMap: Record<string, string> = {
		deepseek: "deepseek",
		gpt: "openai",
		o3: "openai",
		o4: "openai",
		claude: "anthropic",
		gemini: "google",
		qwen: "qwen",
		glm: "zhipu",
		doubao: "volcengine",
	};
	for (const [prefix, provider] of Object.entries(prefixMap)) {
		if (model.startsWith(prefix)) return provider;
	}
	return "openai"; // fallback
}
