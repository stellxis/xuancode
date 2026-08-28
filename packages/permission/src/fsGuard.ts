import path from "node:path";
import type { AgentMode } from "@xuancode/types";

/**
 * 五行 File System Guard — Protects sensitive files and prevents path traversal
 *
 * 信任等级 (TRUST_LEVEL):
 *   plan=0    观 — 只读工作目录内, 绝对路径禁止
 *   default=1 问 — 读全放行, 写需确认, 绝对路径需确认
 *   trust=2   信 — 文件自动, 绝对路径自动
 *   auto=3    任 — 智能决策, 绝对路径自动
 *   bypass=4  化 — 完全信任
 */

const PROTECTED_FILES = [
	".env",
	".env.local",
	".env.production",
	".env.development",
	".gitconfig",
	".git-credentials",
	".bashrc",
	".bash_profile",
	".zshrc",
	".zprofile",
	".profile",
	".npmrc",
	".yarnrc",
	".pnp.cjs",
	"id_rsa",
	"id_rsa.pub",
	"id_ed25519",
	"id_ed25519.pub",
	"known_hosts",
	"authorized_keys",
	".config/",
	"config/",
	"*.pem",
	"*.key",
	"*.crt",
	"*.cert",
];

const PROTECTED_DIRECTORIES = [".git", "node_modules", ".venv", "venv"];

export interface FsGuardResult {
	allowed: boolean;
	reason: string;
	severity: "info" | "warning" | "block";
}

/** Trust level numeric mapping */
const TRUST_LEVEL: Record<AgentMode, number> = {
	plan: 0,
	default: 1,
	trust: 2,
	auto: 3,
	bypass: 4,
};

/** Check if a file path is protected */
export function isProtectedFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const basename = path.basename(normalized);

	for (const protectedFile of PROTECTED_FILES) {
		if (protectedFile.includes("*")) {
			const pattern = protectedFile.replace(/\*/g, ".*");
			if (new RegExp(`^${pattern}$`).test(basename)) return true;
		} else if (
			basename === protectedFile ||
			normalized.endsWith(`/${protectedFile}`)
		) {
			return true;
		}
	}

	for (const dir of PROTECTED_DIRECTORIES) {
		if (
			normalized.includes(`/${dir}/`) ||
			normalized.startsWith(`${dir}/`) ||
			normalized === dir
		) {
			return true;
		}
	}

	return false;
}

/**
 * Resolve a tool path with 五行 trust-level authorization.
 *
 * Returns { allowed, reason, resolvedPath }.
 * - Relative paths: enforce workdir boundary
 * - Absolute paths: check trust level
 * - Protected files: check trust level
 */
export function resolveToolPath(
	workDir: string,
	filePath: string,
	mode: AgentMode,
): { allowed: boolean; reason: string; resolvedPath: string } {
	const trustLevel = TRUST_LEVEL[mode] ?? 1;
	const isAbsolute = path.isAbsolute(filePath);

	// --- Absolute path policy ---
	if (isAbsolute) {
		if (trustLevel < 2) {
			return {
				allowed: false,
				reason: `观/问模式禁止绝对路径: ${filePath} (需 ≥ 信模式)`,
				resolvedPath: filePath,
			};
		}
		// Protected file check applies to absolute paths too
		if (isProtectedFile(filePath) && trustLevel < 3) {
			return {
				allowed: false,
				reason: `保护文件: ${filePath} (需 ≥ 任模式)`,
				resolvedPath: filePath,
			};
		}
		return { allowed: true, reason: "绝对路径已授权", resolvedPath: filePath };
	}

	// --- Relative path policy ---
	const fullPath = path.resolve(workDir, filePath);
	if (!fullPath.startsWith(path.resolve(workDir))) {
		return {
			allowed: false,
			reason: `路径越权: ${filePath} 超出工作目录`,
			resolvedPath: fullPath,
		};
	}

	// Check protected files
	if (isProtectedFile(filePath) && trustLevel < 1) {
		return {
			allowed: false,
			reason: `观模式禁止读取保护文件: ${filePath}`,
			resolvedPath: fullPath,
		};
	}

	// Check .. traversal
	if (filePath.includes("..")) {
		return {
			allowed: false,
			reason: `路径包含 '..' 可能存在越权风险: ${filePath}`,
			resolvedPath: fullPath,
		};
	}

	return { allowed: true, reason: "路径安全", resolvedPath: fullPath };
}

/**
 * Legacy path traversal check (kept for backward compat).
 * Use resolveToolPath() for new code — it handles 五行 trust levels.
 */
export function checkPathTraversal(
	root: string,
	filePath: string,
): FsGuardResult {
	const resolved = path.resolve(root, filePath);

	if (!resolved.startsWith(path.resolve(root))) {
		return {
			allowed: false,
			reason: `路径越权: ${filePath} 超出工作目录`,
			severity: "block",
		};
	}

	if (filePath.includes("..")) {
		return {
			allowed: false,
			reason: "路径包含 '..' 可能存在越权风险",
			severity: "warning",
		};
	}

	return { allowed: true, reason: "路径安全", severity: "info" };
}

export function checkFileWrite(filePath: string): FsGuardResult {
	if (isProtectedFile(filePath)) {
		return {
			allowed: false,
			reason: `保护文件禁止写入: ${filePath}`,
			severity: "block",
		};
	}
	return { allowed: true, reason: "允许写入", severity: "info" };
}

export function checkFileRead(filePath: string): FsGuardResult {
	if (isProtectedFile(filePath)) {
		return {
			allowed: false,
			reason: `保护文件禁止读取: ${filePath}`,
			severity: "block",
		};
	}
	return { allowed: true, reason: "允许读取", severity: "info" };
}
