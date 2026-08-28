/**
 * Shell Command Classifier — Two-stage classification (fast filter + detailed analysis)
 *
 * Inspired by Claude Code's yoloClassifier.ts architecture:
 * 1. Fast filter: regex-based danger detection (sub-millisecond)
 * 2. Detailed analysis: pattern-based risk scoring
 */

export enum CommandRisk {
	SAFE = "safe",
	LOW = "low",
	MEDIUM = "medium",
	HIGH = "high",
	CRITICAL = "critical",
}

export interface ClassificationResult {
	risk: CommandRisk;
	score: number; // 0-100
	reasons: string[];
	suggestedAction: "allow" | "warn" | "block";
}

// Patterns that indicate destructive operations — always blocked, even in bypass mode.
const DESTRUCTIVE_PATTERNS = [
	// rm -rf against root, current dir, or wildcards (broad-scope nukes)
	/\brm\s+(-[a-z]*r[a-z]*\s+)?(-[a-z]*f[a-z]*\s+)?(\/|\.\s*$|\.\s*\/|\*\s*$|\*\s*\/)/,
	/\brm\s+-[a-z]*[rf][a-z]*\s+\/(\s|$)/,
	// git history destruction
	/\bgit\s+push\s+.*(--force|-f\b)/,
	/\bgit\s+push\s+-f\b/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\s+-[a-z]*[fd]/,
	// disk / filesystem wipe
	/\bdd\s+if=/,
	/\bmkfs\b/,
	/\bformat\b/,
	/\bdiskpart\b/,
	/\bfdisk\b/,
	// privilege escalation to root (case-insensitive: isDangerousCommand lowercases input)
	/chmod\s+-r\s+777\s+\//,
	/chown\s+-r\s+root/,
	// fork bomb
	/:\(\)\s*\{/,
	// destructive redirects to system devices
	/>\s*\/dev\/sd[a-z]/,
	// registry / system store nukes (Windows)
	/\breg\s+delete\s+.*\/f\b/i,
];

// Patterns that indicate file modification
const MODIFICATION_PATTERNS = [
	/\brm\b/,
	/\bmv\b/,
	/\bcp\b/,
	/\bsed\s+-i\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/\btruncate\b/,
	/\bdd\b/,
	/\b>\s+\S+/,
	/\b>>\s+\S+/,
];

// Patterns that indicate network operations
const NETWORK_PATTERNS = [
	/\bcurl\b/,
	/\bwget\b/,
	/\bnc\b/,
	/\bnetcat\b/,
	/\bssh\b/,
	/\bscp\b/,
	/\brsync\b/,
	/\biptables\b/,
];

// Patterns that indicate info-gathering (generally safe)
const INFO_PATTERNS = [
	/\bls\b/,
	/\bcat\b/,
	/\bhead\b/,
	/\btail\b/,
	/\bgrep\b/,
	/\bfind\b/,
	/\bwhich\b/,
	/\bwhere\b/,
	/\bpwd\b/,
	/\bdf\b/,
	/\bdu\b/,
	/\buname\b/,
	/\bwhoami\b/,
	/\bdate\b/,
	/\becho\b/,
	/\btype\b/,
];

/**
 * Two-stage shell command classifier
 */
export function classifyCommand(command: string): ClassificationResult {
	const lower = command.trim().toLowerCase();
	const reasons: string[] = [];
	let score = 0;

	// Stage 1: Fast filter — check destructive patterns
	for (const pattern of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(lower)) {
			score += 60;
			reasons.push(`匹配危险模式: ${pattern.source.slice(0, 40)}`);
		}
	}

	// Stage 2: Detailed analysis
	const matchedModify = MODIFICATION_PATTERNS.filter((p) => p.test(lower));
	const matchedNetwork = NETWORK_PATTERNS.filter((p) => p.test(lower));
	const matchedInfo = INFO_PATTERNS.filter((p) => p.test(lower));

	// Modification score
	if (matchedModify.length > 0) {
		const modScore = Math.min(matchedModify.length * 10, 30);
		score += modScore;
		if (matchedModify.length <= 2) {
			reasons.push(`轻度文件操作: ${matchedModify[0].source.slice(0, 20)}`);
		} else {
			reasons.push(`批量文件操作: ${matchedModify.length} 个匹配`);
		}
	}

	// Network score
	if (matchedNetwork.length > 0) {
		score += 20;
		reasons.push(`网络操作: ${matchedNetwork[0].source.slice(0, 20)}`);
	}

	// Check for pipes and chains (increases risk)
	const pipeCount = (lower.match(/\|/g) || []).length;
	if (pipeCount > 2) {
		score += 15;
		reasons.push(`复杂管道链: ${pipeCount} 个管道`);
	}

	// Check for sudo (elevated risk)
	if (lower.includes("sudo")) {
		score += 25;
		reasons.push("使用 sudo 提权");
	}

	// If only info commands, reduce score
	if (
		matchedInfo.length > 0 &&
		matchedModify.length === 0 &&
		matchedNetwork.length === 0
	) {
		score = Math.max(0, score - 20);
		reasons.push("仅信息查询操作");
	}

	// Determine risk level
	let risk: CommandRisk;
	let suggestedAction: "allow" | "warn" | "block";

	if (score >= 70) {
		risk = CommandRisk.CRITICAL;
		suggestedAction = "block";
	} else if (score >= 50) {
		risk = CommandRisk.HIGH;
		suggestedAction = "block";
	} else if (score >= 30) {
		risk = CommandRisk.MEDIUM;
		suggestedAction = "warn";
	} else if (score >= 10) {
		risk = CommandRisk.LOW;
		suggestedAction = "warn";
	} else {
		risk = CommandRisk.SAFE;
		suggestedAction = "allow";
	}

	return { risk, score, reasons, suggestedAction };
}

/**
 * Check if a command matches any dangerous patterns (fast check)
 */
export function isDangerousCommand(command: string): boolean {
	return DESTRUCTIVE_PATTERNS.some((p) => p.test(command.toLowerCase()));
}
