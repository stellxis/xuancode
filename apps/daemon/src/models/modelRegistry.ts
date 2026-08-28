import fs from "node:fs";
import path from "node:path";
import { RetryAdapter } from "@xuancode/model-adapter";
import type { ApiToolDefinition, ModelAdapter } from "@xuancode/model-adapter";
import { LegacyBridgeAdapter, ModelRouter } from "@xuancode/model-router";
import {
	AnthropicAdapter,
	DeepSeekAdapter,
	GeminiAdapter,
	OllamaAdapter,
	OpenAIAdapter,
	QwenAdapter,
	VolcengineAdapter,
	ZhipuAIAdapter,
} from "@xuancode/model-router";
import type { ProviderAdapter } from "@xuancode/model-router";
import type { Message } from "@xuancode/types";

export interface ModelEntry {
	provider: string;
	modelName: string;
	label: string;
	description?: string;
	baseURL: string;
	contextWindow: number;
	maxOutputTokens: number;
	supportsVision: boolean;
	supportsToolCalling: boolean;
	costPer1KInput: number;
	costPer1KOutput: number;
	latencyP50: number;
}

const DEFAULT_MODELS: ModelEntry[] = [
	// DeepSeek（最新）
	{
		provider: "deepseek",
		modelName: "deepseek-v4-flash",
		label: "DeepSeek V4 Flash",
		description: "Fast general-purpose model",
		baseURL: "https://api.deepseek.com",
		contextWindow: 128_000,
		maxOutputTokens: 8192,
		supportsVision: false,
		supportsToolCalling: true,
		costPer1KInput: 0.0005,
		costPer1KOutput: 0.002,
		latencyP50: 800,
	},
	{
		provider: "deepseek",
		modelName: "deepseek-v4-pro",
		label: "DeepSeek V4 Pro",
		description: "Premium high-performance model",
		baseURL: "https://api.deepseek.com",
		contextWindow: 128_000,
		maxOutputTokens: 8192,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.002,
		costPer1KOutput: 0.008,
		latencyP50: 1200,
	},
	// 阿里千问（2026.05 更新）
	{
		provider: "qwen",
		modelName: "qwen3.7-max",
		label: "通义千问 3.7 Max",
		description: "阿里云通义千问旗舰模型（2026.05）",
		baseURL: "https://dashscope.aliyuncs.com/compatible-mode",
		contextWindow: 128_000,
		maxOutputTokens: 8192,
		supportsVision: false,
		supportsToolCalling: true,
		costPer1KInput: 0.0004,
		costPer1KOutput: 0.0015,
		latencyP50: 900,
	},
	{
		provider: "qwen",
		modelName: "qwen3.5-omni-plus",
		label: "通义千问 3.5 Omni Plus",
		description: "全模态模型（支持图片/音频/视频）",
		baseURL: "https://dashscope.aliyuncs.com/compatible-mode",
		contextWindow: 128_000,
		maxOutputTokens: 8192,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.0005,
		costPer1KOutput: 0.002,
		latencyP50: 1000,
	},
	// OpenAI（2026.03 更新）
	{
		provider: "openai",
		modelName: "gpt-5.4-thinking",
		label: "OpenAI GPT-5.4 Thinking",
		description: "OpenAI 旗舰推理模型",
		baseURL: "https://api.openai.com/v1",
		contextWindow: 1_000_000,
		maxOutputTokens: 16384,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.0025,
		costPer1KOutput: 0.015,
		latencyP50: 1500,
	},
	{
		provider: "openai",
		modelName: "gpt-5.3-instant",
		label: "OpenAI GPT-5.3 Instant",
		description: "快速默认模型",
		baseURL: "https://api.openai.com/v1",
		contextWindow: 1_000_000,
		maxOutputTokens: 8192,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.00125,
		costPer1KOutput: 0.005,
		latencyP50: 500,
	},
	// Anthropic（2026.04 更新）
	{
		provider: "anthropic",
		modelName: "claude-sonnet-4-6",
		label: "Claude Sonnet 4.6",
		description: "Anthropic 最新 Sonnet（2026.02）",
		baseURL: "https://api.anthropic.com/v1",
		contextWindow: 1_000_000,
		maxOutputTokens: 65536,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.003,
		costPer1KOutput: 0.015,
		latencyP50: 600,
	},
	{
		provider: "anthropic",
		modelName: "claude-opus-4-7",
		label: "Claude Opus 4.7",
		description: "Anthropic 最强模型（2026.04）",
		baseURL: "https://api.anthropic.com/v1",
		contextWindow: 1_000_000,
		maxOutputTokens: 65536,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.015,
		costPer1KOutput: 0.075,
		latencyP50: 1000,
	},
	// Google（2026.02 更新）
	{
		provider: "google",
		modelName: "gemini-3.1-pro-preview",
		label: "Gemini 3.1 Pro",
		description: "Google 最新旗舰模型",
		baseURL: "https://generativelanguage.googleapis.com/v1beta",
		contextWindow: 1_000_000,
		maxOutputTokens: 65536,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.00125,
		costPer1KOutput: 0.005,
		latencyP50: 800,
	},
	{
		provider: "google",
		modelName: "gemini-3-flash",
		label: "Gemini 3 Flash",
		description: "Google 快速默认模型",
		baseURL: "https://generativelanguage.googleapis.com/v1beta",
		contextWindow: 1_000_000,
		maxOutputTokens: 65536,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.0005,
		costPer1KOutput: 0.003,
		latencyP50: 400,
	},
	// Ollama 本地
	{
		provider: "ollama",
		modelName: "qwen3.7-max",
		label: "Ollama (本地)",
		description: "本地运行的通义千问",
		baseURL: "http://localhost:11434",
		contextWindow: 32_000,
		maxOutputTokens: 4096,
		supportsVision: false,
		supportsToolCalling: false,
		costPer1KInput: 0,
		costPer1KOutput: 0,
		latencyP50: 200,
	},
	// 智谱 AI（2026.05 更新）
	{
		provider: "zhipu",
		modelName: "glm-5",
		label: "智谱 GLM-5",
		description: "智谱 AI 旗舰模型 744B（2026.02）",
		baseURL: "https://open.bigmodel.cn/api/paas/v4",
		contextWindow: 202_000,
		maxOutputTokens: 8192,
		supportsVision: false,
		supportsToolCalling: true,
		costPer1KInput: 0.0002,
		costPer1KOutput: 0.0002,
		latencyP50: 700,
	},
	{
		provider: "zhipu",
		modelName: "glm-5v-turbo",
		label: "智谱 GLM-5V Turbo",
		description: "智谱 AI 多模态模型（2026.05）",
		baseURL: "https://open.bigmodel.cn/api/paas/v4",
		contextWindow: 202_000,
		maxOutputTokens: 8192,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.0005,
		costPer1KOutput: 0.0005,
		latencyP50: 900,
	},
	// 火山引擎（2026.05 更新）
	{
		provider: "volcengine",
		modelName: "doubao-seed-2-0-pro",
		label: "火山引擎 Doubao Seed 2.0 Pro",
		description: "豆包旗舰模型",
		baseURL: "https://ark.cn-beijing.volces.com/api/v3",
		contextWindow: 128_000,
		maxOutputTokens: 8192,
		supportsVision: false,
		supportsToolCalling: true,
		costPer1KInput: 0.0003,
		costPer1KOutput: 0.0009,
		latencyP50: 600,
	},
	{
		provider: "volcengine",
		modelName: "doubao-seed-2-0-lite-260428",
		label: "火山引擎 Doubao Seed 2.0 Lite",
		description: "豆包全模态理解模型（2026.05）",
		baseURL: "https://ark.cn-beijing.volces.com/api/v3",
		contextWindow: 128_000,
		maxOutputTokens: 8192,
		supportsVision: true,
		supportsToolCalling: true,
		costPer1KInput: 0.0003,
		costPer1KOutput: 0.0009,
		latencyP50: 500,
	},
];

const ADAPTER_MAP: Record<string, new (model: string, config: any) => any> = {
	deepseek: DeepSeekAdapter,
	qwen: QwenAdapter,
	openai: OpenAIAdapter,
	anthropic: AnthropicAdapter,
	google: GeminiAdapter,
	ollama: OllamaAdapter,
	zhipu: ZhipuAIAdapter,
	volcengine: VolcengineAdapter,
};

// Runtime state
let _models: ModelEntry[] = [...DEFAULT_MODELS];
let _overridesPath = "";

export function initModelRegistry(workDir: string): void {
	_overridesPath = path.join(workDir, ".xuancode", "models-override.json");
	reloadOverrides();
}

export function reloadOverrides(): void {
	_models = DEFAULT_MODELS.map((m) => ({ ...m }));

	if (!_overridesPath) return;
	try {
		if (fs.existsSync(_overridesPath)) {
			const raw = fs.readFileSync(_overridesPath, "utf-8");
			const overrides: Partial<ModelEntry>[] = JSON.parse(raw);
			if (Array.isArray(overrides)) {
				for (const override of overrides) {
					const idx = _models.findIndex(
						(m) =>
							m.provider === override.provider &&
							m.modelName === override.modelName,
					);
					if (idx >= 0) {
						_models[idx] = { ..._models[idx], ...override };
					} else if (override.provider && override.modelName) {
						_models.push(override as ModelEntry);
					}
				}
			}
		}
	} catch (e) {
		console.error("[模型注册表] 覆盖配置加载失败:", e);
	}
}

/** Override the entire runtime model list (used by Worker threads) */
export function setModels(models: ModelEntry[]): void {
	_models = models;
}

export function getModels(): ModelEntry[] {
	return _models;
}

export function updateModel(
	provider: string,
	modelName: string,
	updates: Partial<ModelEntry>,
): ModelEntry | null {
	const idx = _models.findIndex(
		(m) => m.provider === provider && m.modelName === modelName,
	);
	if (idx < 0) return null;

	_models[idx] = { ..._models[idx], ...updates };

	// Persist: compute diff from defaults for all models
	persistOverrides();
	return _models[idx];
}

export function addModel(entry: ModelEntry): void {
	_models.push(entry);
	persistOverrides();
}

export function removeModel(provider: string, modelName: string): boolean {
	const idx = _models.findIndex(
		(m) => m.provider === provider && m.modelName === modelName,
	);
	if (idx < 0) return false;
	_models.splice(idx, 1);
	persistOverrides();
	return true;
}

function persistOverrides(): void {
	if (!_overridesPath) return;
	try {
		const dir = path.dirname(_overridesPath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

		const diffs: Partial<ModelEntry>[] = [];
		for (const m of _models) {
			const def = DEFAULT_MODELS.find(
				(d) => d.provider === m.provider && d.modelName === m.modelName,
			);
			if (!def) {
				// Entirely new model
				diffs.push(m);
				continue;
			}
			const diff: Record<string, any> = {};
			for (const key of Object.keys(m) as (keyof ModelEntry)[]) {
				if (key === "label" || key === "description") continue; // skip display-only fields
				if (JSON.stringify(m[key]) !== JSON.stringify(def[key])) {
					diff[key] = m[key];
				}
			}
			if (Object.keys(diff).length > 0 && diff.provider && diff.modelName) {
				diffs.push(diff as Partial<ModelEntry>);
			}
		}
		fs.writeFileSync(_overridesPath, JSON.stringify(diffs, null, 2));
	} catch (e) {
		console.error("[模型注册表] 持久化失败:", e);
	}
}

/** 反向桥接：model-router ProviderAdapter → model-adapter ModelAdapter（供 RetryAdapter 包装） */
class ReverseBridge implements ModelAdapter {
	readonly provider: string;
	readonly modelName: string;
	constructor(private inner: ProviderAdapter) {
		this.provider = inner.provider;
		this.modelName = inner.model;
	}
	chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string> {
		return this.inner.chat(messages, systemPrompt, tools as never);
	}
	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<string, void, unknown> {
		for await (const ev of this.inner.chatStream(
			messages,
			systemPrompt,
			tools as never,
		)) {
			if (typeof ev === "string") yield ev; // 桥接为字符串适配器，结构化工具事件不进入 legacy 文本通道
		}
	}
}

export interface CreateModelOptions {
	/** 失败自动重试（指数退避）+ 第一备用模型跨模型回退；默认开启，可关 */
	retryOnFail?: boolean;
}

export function createModel(
	provider: string,
	modelName: string,
	options?: CreateModelOptions,
): ModelRouter {
	const router = new ModelRouter();
	const retryOnFail = options?.retryOnFail !== false;

	for (const entry of _models) {
		const AdapterClass = ADAPTER_MAP[entry.provider];
		if (!AdapterClass) {
			console.error(
				`[模型注册表] 未知提供商 "${entry.provider}"，跳过模型 "${entry.modelName}"`,
			);
			continue;
		}

		router.registry.register(
			{
				provider: entry.provider,
				modelName: entry.modelName,
				contextWindow: entry.contextWindow,
				supportsVision: entry.supportsVision,
				supportsToolCalling: entry.supportsToolCalling,
				costPer1KInput: entry.costPer1KInput,
				costPer1KOutput: entry.costPer1KOutput,
				latencyP50: entry.latencyP50,
				maxOutputTokens: entry.maxOutputTokens,
			},
			new AdapterClass(entry.modelName, { baseUrl: entry.baseURL }),
		);
	}

	let activeProvider = provider;
	let activeModel = modelName;
	try {
		router.setProvider(provider, modelName);
	} catch {
		// Fallback to first available model
		try {
			const first = _models[0];
			if (first) {
				router.setProvider(first.provider, first.modelName);
				activeProvider = first.provider;
				activeModel = first.modelName;
			}
		} catch {
			/* ignore */
		}
	}

	if (retryOnFail) {
		const activeCap = router.registry.getCapability(
			activeProvider,
			activeModel,
		);
		const activeRaw = router.registry.getAdapter(activeProvider, activeModel);
		if (activeCap && activeRaw) {
			// 主模型包一层 RetryAdapter（3 次指数退避），经 LegacyBridge 重新注册为 ProviderAdapter 并重设为主模型
			const retryProvider = new LegacyBridgeAdapter(
				new RetryAdapter(new ReverseBridge(activeRaw), { maxRetries: 3 }),
			);
			router.registry.register(activeCap, retryProvider);
			try {
				router.setProvider(activeProvider, activeModel);
			} catch {
				/* ignore */
			}
			// 第一备用模型（与主模型不同）作为 fallbackAdapter，跨模型回退
			const backup = _models.find(
				(m) => !(m.provider === activeProvider && m.modelName === activeModel),
			);
			if (backup) {
				const backupAdapter = router.registry.getAdapter(
					backup.provider,
					backup.modelName,
				);
				if (backupAdapter) router.setFallback(new ReverseBridge(backupAdapter));
			}
		}
	}

	return router;
}
