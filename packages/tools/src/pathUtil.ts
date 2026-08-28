import path from "node:path";

const WIN_PATH_THRESHOLD = 240;

/**
 * Resolve a relative path against root, with Windows extended-length prefix
 * for paths near the MAX_PATH (260 char) limit.
 *
 * On Windows, paths exceeding 260 characters require the `\\?\` prefix.
 * This function transparently adds the prefix when needed.
 */
export function resolvePath(root: string, relative: string): string {
	const resolved = path.resolve(root, relative);
	if (process.platform !== "win32") return resolved;
	// Only add the extended-length prefix for long paths
	if (resolved.length < WIN_PATH_THRESHOLD) return resolved;
	// Convert forward slashes to backslashes (required for \\?\ prefix)
	const normalized = resolved.replace(/\//g, "\\");
	if (normalized.startsWith("\\\\?\\")) return normalized;
	return `\\\\?\\${normalized}`;
}

/**
 * Normalize a workDir or absolute path for Windows long-path compatibility.
 * Unlike resolvePath, this directly adds `\\?\` to an already-absolute path.
 */
export function normalizeLongPath(absPath: string): string {
	if (process.platform !== "win32") return absPath;
	if (absPath.length < WIN_PATH_THRESHOLD) return absPath;
	const normalized = absPath.replace(/\//g, "\\");
	if (normalized.startsWith("\\\\?\\")) return normalized;
	return `\\\\?\\${normalized}`;
}
