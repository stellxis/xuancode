/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
	if (str.length <= maxLength) return str;
	return `${str.slice(0, maxLength - 3)}...`;
}

/**
 * Safe JSON parse with fallback
 */
export function safeJsonParse<T>(str: string, fallback: T): T {
	try {
		return JSON.parse(str) as T;
	} catch {
		return fallback;
	}
}

/**
 * Debounce a function
 */
export function debounce<T extends (...args: any[]) => any>(
	fn: T,
	delay: number,
): (...args: Parameters<T>) => void {
	let timer: ReturnType<typeof setTimeout>;
	return (...args: Parameters<T>) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), delay);
	};
}

export {
	resolveHome,
	resolveProjectData,
	resolveServerData,
	resolveManagedPolicy,
	resolveMemoryScopeDir,
} from "./paths";
export { repoSlug, sanitizeRepoSlug, simpleHash } from "./repoSlug";
export {
	migrateHomeDir,
	migrateProjectData,
	migrateServerData,
} from "./migrate";
export { cleanupHomeRoot, cleanupProjectRoot } from "./gc";
