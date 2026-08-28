/**
 * 鉴 (Review) Agent — 代码审查
 *
 * 对抗性审查立场,寻找bug、安全漏洞和设计问题
 */
export async function reviewAgent(task: string, context: any): Promise<string> {
	return `[鉴] 审查代码: ${task}`;
}
