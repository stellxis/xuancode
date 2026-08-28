/**
 * 策 (Plan) Agent — 方案设计
 *
 * 只读Agent,分析需求后制定实施计划
 */
export async function planAgent(task: string, context: any): Promise<string> {
	return `[策] 设计方案: ${task}`;
}
