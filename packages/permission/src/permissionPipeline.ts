import type { AgentMode } from "@xuancode/types";
import { isProtectedFile, resolveToolPath } from "./fsGuard";
import {
	type ClassificationResult,
	classifyCommand,
	isDangerousCommand,
} from "./shellClassifier";

/**
 * 五行 Permission Pipeline — 统一越权门控
 *
 * 四层纵深防御 (Defense in Depth):
 *   1. 观(plan)   — 只读: glob/grep/list_dir/read_file 仅工作目录内
 *   2. 问(default)  — 每次执行前询问
 *   3. 信(trust)   — 文件自动, Shell 分类决策
 *   4. 任(auto)    — 智能分类, 低风险自动放行
 *   5. 化(bypass)  — 完全信任
 *
 * 调用路径: ToolManager.dispatch() → checkPermission() → handler
 */

export interface PermissionRequest {
	toolType: string;
	params: Record<string, unknown>;
	mode: AgentMode;
	workDir: string;
}

export interface PermissionDecision {
	allowed: boolean;
	reason: string;
	requireConfirm: boolean;
	risk?: ClassificationResult;
	pipelineStage: string;
	/** Resolved absolute path (for path-based tools), undefined if no path resolution needed */
	resolvedPath?: string;
}

const TRUST_LEVEL: Record<AgentMode, number> = {
	plan: 0,
	default: 1,
	trust: 2,
	auto: 3,
	bypass: 4,
};

/**
 * Run the full 五行 permission pipeline
 */
export function checkPermission(
	request: PermissionRequest,
): PermissionDecision {
	const { toolType, params, mode, workDir } = request;
	const trustLevel = TRUST_LEVEL[mode] ?? 1;

	// ===== STAGE 1: Mode Pre-filter =====
	if (
		trustLevel === 0 &&
		![
			"read_file",
			"list_dir",
			"grep",
			"glob",
			"web_search",
			"web_fetch",
		].includes(toolType)
	) {
		return deny(`观模式: 只允许读取操作 (${toolType} 被禁止)`, "pre_filter");
	}

	// ===== STAGE 2: Shell Command Pipeline =====
	if (toolType === "shell") {
		return handleShell((params.command as string) || "", trustLevel);
	}

	// ===== STAGE 3: Path-based Tool Pipeline =====
	const filePath = getPathParam(toolType, params);
	if (filePath) {
		return handlePathTool(toolType, filePath, trustLevel, workDir);
	}

	// ===== STAGE 4: Default =====
	// 交互式工具本身即与用户沟通（ask_user 会自行向用户提问并等待选择），
	// 不应再被通用权限确认闸门阻塞 —— 否则在问模式(default)下会卡在等待权限确认。
	const NO_CONFIRM_INTERACTIVE = toolType === "ask_user";
	return {
		allowed: true,
		reason: `工具 ${toolType} 无特殊限制`,
		requireConfirm: !NO_CONFIRM_INTERACTIVE && trustLevel <= 1,
		pipelineStage: "default",
	};
}

// ─── Internal handlers ───

function handleShell(command: string, trustLevel: number): PermissionDecision {
	if (isDangerousCommand(command)) {
		return deny("五行 · 火: 高危命令被拦截", "danger_patterns");
	}

	const classification = classifyCommand(command);

	if (trustLevel >= 4) {
		return allow(`化模式: 自动放行 (风险: ${classification.risk})`, "bypass");
	}

	if (trustLevel >= 3) {
		// 任 mode: block only if classifier says block
		if (classification.suggestedAction === "block") {
			return deny(
				`AI分类拦截: ${classification.reasons.join("; ")}`,
				"classifier",
				classification,
			);
		}
		return {
			allowed: true,
			reason: `任模式: 自动放行 (风险: ${classification.risk})`,
			requireConfirm: classification.suggestedAction === "warn",
			risk: classification,
			pipelineStage: "classifier",
		};
	}

	if (trustLevel >= 2) {
		const needsConfirm =
			classification.risk !== "safe" && classification.risk !== "low";
		return {
			allowed: true,
			reason: `信模式: ${needsConfirm ? "需确认" : "自动放行"} (风险: ${classification.risk})`,
			requireConfirm: needsConfirm,
			risk: classification,
			pipelineStage: "trust_auto",
		};
	}

	// default mode: always ask
	return {
		allowed: true,
		reason: `问模式: 需要用户确认 (风险: ${classification.risk})`,
		requireConfirm: true,
		risk: classification,
		pipelineStage: "ask_user",
	};
}

function handlePathTool(
	toolType: string,
	filePath: string,
	trustLevel: number,
	workDir: string,
): PermissionDecision {
	// Use mode "bypass" for internal resolution so resolveToolPath only does security checks,
	// since we already checked the mode above
	const isWriteOp = toolType === "write_file" || toolType === "edit_file";

	// Resolve + authorize the path
	const pathResult = resolveToolPath(
		workDir,
		filePath,
		getEffectiveMode(trustLevel),
	);

	if (!pathResult.allowed) {
		return deny(pathResult.reason, "fs_guard");
	}

	// Protected file check
	if (isProtectedFile(filePath)) {
		if (isWriteOp) {
			if (trustLevel < 3) {
				return deny(`保护文件禁止写入: ${filePath} (需 ≥ 任模式)`, "fs_guard");
			}
			return {
				allowed: true,
				reason: `任/化模式: 允许写入保护文件 ${filePath}`,
				requireConfirm: false,
				pipelineStage: "trust_auto",
				resolvedPath: pathResult.resolvedPath,
			};
		}
		// For reads: plan mode blocks, all others allow with possible confirmation
		if (trustLevel < 1) {
			return deny(`观模式禁止操作保护文件: ${filePath}`, "fs_guard");
		}
	}

	// Trust-level-based confirmation
	if (isWriteOp && trustLevel <= 1) {
		return {
			allowed: true,
			reason: `问模式: 需要确认写入 ${filePath}`,
			requireConfirm: true,
			pipelineStage: "ask_user",
			resolvedPath: pathResult.resolvedPath,
		};
	}

	return {
		allowed: true,
		reason: trustLevel >= 2 ? "五行 · 自动放行" : "允许操作",
		requireConfirm: false,
		pipelineStage: trustLevel >= 2 ? "trust_auto" : "ask_user",
		resolvedPath: pathResult.resolvedPath,
	};
}

// ─── Helpers ───

function getPathParam(
	toolType: string,
	params: Record<string, unknown>,
): string | null {
	if (["read_file", "write_file", "edit_file", "list_dir"].includes(toolType)) {
		return (params.path || params.dirPath || "") as string;
	}
	return null;
}

function getEffectiveMode(trustLevel: number): AgentMode {
	if (trustLevel >= 4) return "bypass";
	if (trustLevel >= 3) return "auto";
	if (trustLevel >= 2) return "trust";
	if (trustLevel >= 1) return "default";
	return "plan";
}

function deny(
	reason: string,
	stage: string,
	risk?: ClassificationResult,
): PermissionDecision {
	return {
		allowed: false,
		reason,
		requireConfirm: false,
		risk,
		pipelineStage: stage,
	};
}

function allow(reason: string, stage: string): PermissionDecision {
	return { allowed: true, reason, requireConfirm: false, pipelineStage: stage };
}

// ─── User-facing descriptions ───

export function getModeDescription(mode: AgentMode): string {
	const descriptions: Record<AgentMode, string> = {
		plan: "观 — 只读模式,仅允许查看工作目录内文件",
		default: "问 — 每次操作需要用户确认",
		trust: "信 — 文件编辑自动放行,Shell需确认,绝对路径自动",
		auto: "任 — 智能分类决策,低风险自动放行,绝对路径自动",
		bypass: "化 — 完全信任,所有操作自动放行",
	};
	return descriptions[mode] || "未知模式";
}
