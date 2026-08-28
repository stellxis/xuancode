/**
 * 探 (Explore) Agent — 代码搜索与理解
 *
 * 只读Agent,使用 Glob/Grep/Read 进行代码库探索
 */
export async function exploreAgent(
	task: string,
	context: any,
): Promise<string> {
	return `[探] 搜索代码库: ${task}`;
}
