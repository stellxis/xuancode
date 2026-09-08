/** /help 面板文本与输入补全建议 — App.tsx 拆出的常量 */

export const HELP_TEXT = `
  ┌─ 玄码指令 ─────────────────────────────────────────┐
  │ /help          — 显示此帮助面板                       │
  │ /status        — 显示当前状态                        │
  │ /plan <任务>   — 先规划再执行多步骤任务               │
  │ /mode <模式>   — 切换信任模式                        │
  │                  plan / default / trust / auto / bypass │
  │ /clear         — 清除会话历史                        │
  │ /tasks [id]    — 列出任务 / 重连运行中的任务          │
  │ exit/quit      — 退出玄码                           │
  └────────────────────────────────────────────────────┘

  信任模式:
    观(plan)    — 仅规划，不执行任何操作
    问(default) — 每次执行前询问
    信(trust)   — 文件自动，Shell 询问
    任(auto)    — 自动决策低风险操作
    化(bypass)  — 完全自动，不确认

  快捷键:
    Ctrl+L       — 清除会话
    Escape       — 关闭帮助面板
`;

const COMMANDS = [
	"/help",
	"/status",
	"/plan ",
	"/mode plan",
	"/mode default",
	"/mode trust",
	"/mode auto",
	"/mode bypass",
	"/clear",
	"/tasks ",
	"exit",
	"quit",
];

/** 输入补全建议引擎 */
export function getSuggestions(prefix: string): string[] {
	if (!prefix) return [];
	return COMMANDS.filter((c) => c.startsWith(prefix) && c !== prefix);
}
