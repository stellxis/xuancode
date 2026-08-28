import type { AgentMode } from "@xuancode/types";

export { classifyCommand, isDangerousCommand } from "./shellClassifier";
export type { ClassificationResult } from "./shellClassifier";
export { CommandRisk } from "./shellClassifier";

export {
	isProtectedFile,
	checkPathTraversal,
	checkFileWrite,
	checkFileRead,
	resolveToolPath,
} from "./fsGuard";
export type { FsGuardResult } from "./fsGuard";

export { checkPermission, getModeDescription } from "./permissionPipeline";
export type {
	PermissionRequest,
	PermissionDecision,
} from "./permissionPipeline";

// ==== Trust Level Mapping ====

export type TrustLevel = "observe" | "ask" | "trust" | "auto" | "transcend";

export const TRUST_LEVEL: Record<AgentMode, number> = {
	plan: 0,
	default: 1,
	trust: 2,
	auto: 3,
	bypass: 4,
};

export const MODE_MAP: Record<AgentMode, TrustLevel> = {
	plan: "observe",
	default: "ask",
	trust: "trust",
	auto: "auto",
	bypass: "transcend",
};
