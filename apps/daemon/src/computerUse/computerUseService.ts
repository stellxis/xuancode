import { execSync } from "node:child_process";
import type { ToolResult } from "@xuancode/types";

/**
 * ComputerUseService — 封装桌面控制操作
 *
 * 所有鼠标/键盘操作通过 PowerShell 调用 Windows API 实现：
 * - mouse_event (user32.dll) 用于鼠标点击、滚动
 * - Cursor.Position 用于鼠标移动
 * - SendKeys 用于键盘输入
 * - screenshot-desktop 用于截图
 *
 * 每个操作有 5 秒超时保护，防止 PowerShell 卡死。
 */

// ── PowerShell 内嵌 C# 代码 — mouse_event ──
const MOUSE_EVENT_SCRIPT = `
Add-Type @"
using System.Runtime.InteropServices;
public class Mouse {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void GetCursorPos(out Point lpPoint);
}
public struct Point { public int X, Y; }
"@
`;

const MOUSE_DOWN = 0x0002;
const MOUSE_UP = 0x0004;
const MOUSE_RIGHTDOWN = 0x0008;
const MOUSE_RIGHTUP = 0x0010;
const MOUSE_WHEEL = 0x0800;

function ps(script: string): string {
	return execSync(
		`powershell.exe -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
		{
			timeout: 5000,
			encoding: "utf-8",
			windowsHide: true,
		},
	);
}

export class ComputerUseService {
	private _enabled = false;

	get enabled(): boolean {
		return this._enabled;
	}

	setEnabled(v: boolean): void {
		this._enabled = v;
	}

	private assertEnabled(): void {
		if (!this._enabled) throw new Error("计算机控制未启用");
	}

	// ── Screenshot ──

	async takeScreenshot(): Promise<ToolResult> {
		try {
			this.assertEnabled();
			const screenshot = await import("screenshot-desktop");
			const imgBuf = await screenshot.default({ format: "png" });
			return { success: true, data: imgBuf.toString("base64") };
		} catch (err: any) {
			return { success: false, data: "", error: err.message || "截图失败" };
		}
	}

	// ── Mouse ──

	async mouseMove(x: number, y: number): Promise<ToolResult> {
		try {
			this.assertEnabled();
			ps(
				`[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
			);
			return { success: true, data: `鼠标移动到 (${x}, ${y})` };
		} catch (err: any) {
			return { success: false, data: "", error: err.message || "鼠标移动失败" };
		}
	}

	async mouseClick(button: "left" | "right" | "double"): Promise<ToolResult> {
		try {
			this.assertEnabled();
			if (button === "left") {
				ps(
					`${MOUSE_EVENT_SCRIPT} [Mouse]::mouse_event(${MOUSE_DOWN},0,0,0,0); Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(${MOUSE_UP},0,0,0,0)`,
				);
			} else if (button === "right") {
				ps(
					`${MOUSE_EVENT_SCRIPT} [Mouse]::mouse_event(${MOUSE_RIGHTDOWN},0,0,0,0); Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(${MOUSE_RIGHTUP},0,0,0,0)`,
				);
			} else if (button === "double") {
				ps(
					`${MOUSE_EVENT_SCRIPT} [Mouse]::mouse_event(${MOUSE_DOWN},0,0,0,0); Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(${MOUSE_UP},0,0,0,0); Start-Sleep -Milliseconds 100; [Mouse]::mouse_event(${MOUSE_DOWN},0,0,0,0); Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(${MOUSE_UP},0,0,0,0)`,
				);
			}
			return {
				success: true,
				data: `鼠标${button === "double" ? "双击" : button === "right" ? "右键" : "左键"}点击`,
			};
		} catch (err: any) {
			return { success: false, data: "", error: err.message || "鼠标点击失败" };
		}
	}

	async mouseDrag(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
	): Promise<ToolResult> {
		try {
			this.assertEnabled();
			ps(
				`${MOUSE_EVENT_SCRIPT} [Mouse]::SetCursorPos(${x1},${y1}); [Mouse]::mouse_event(${MOUSE_DOWN},0,0,0,0); [Mouse]::SetCursorPos(${x2},${y2}); [Mouse]::mouse_event(${MOUSE_UP},0,0,0,0)`,
			);
			return { success: true, data: `从 (${x1}, ${y1}) 拖拽到 (${x2}, ${y2})` };
		} catch (err: any) {
			return { success: false, data: "", error: err.message || "拖拽失败" };
		}
	}

	async scroll(deltaX: number, deltaY: number): Promise<ToolResult> {
		try {
			this.assertEnabled();
			ps(
				`${MOUSE_EVENT_SCRIPT} [Mouse]::mouse_event(${MOUSE_WHEEL},${deltaX},${deltaY},0,0)`,
			);
			return {
				success: true,
				data: `滚动: deltaX=${deltaX}, deltaY=${deltaY}`,
			};
		} catch (err: any) {
			return { success: false, data: "", error: err.message || "滚动失败" };
		}
	}

	// ── Keyboard ──

	async typeText(text: string): Promise<ToolResult> {
		try {
			this.assertEnabled();
			const escaped = this.escapeSendKeys(text);
			ps(`[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
			return {
				success: true,
				data: `输入文本: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`,
			};
		} catch (err: any) {
			return { success: false, data: "", error: err.message || "键盘输入失败" };
		}
	}

	async pressKey(key: string): Promise<ToolResult> {
		try {
			this.assertEnabled();
			const mapped = this.mapKey(key);
			ps(`[System.Windows.Forms.SendKeys]::SendWait('${mapped}')`);
			return { success: true, data: `按键: ${key}` };
		} catch (err: any) {
			return { success: false, data: "", error: err.message || "按键失败" };
		}
	}

	// ── Screen info ──

	async getScreenSize(): Promise<ToolResult> {
		try {
			this.assertEnabled();
			const out = ps(
				`Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "{\\\\"width\\":$($b.Width),\\"height\\":$($b.Height),\\"left\\":$($b.X),\\"top\\":$($b.Y)}"`,
			);
			const dims = JSON.parse(out.trim());
			return { success: true, data: JSON.stringify(dims) };
		} catch (err: any) {
			return {
				success: false,
				data: "",
				error: err.message || "获取屏幕信息失败",
			};
		}
	}

	// ── Private helpers ──

	private escapeSendKeys(text: string): string {
		// SendKeys special chars: + ^ % ~ ( ) { } [ ]
		return text
			.replace(/\+/g, "{+}")
			.replace(/\^/g, "{^}")
			.replace(/\%/g, "{%}")
			.replace(/~/g, "{~}")
			.replace(/\(/g, "{(}")
			.replace(/\)/g, "{)}")
			.replace(/\{/g, "{{}")
			.replace(/\}/g, "{}}")
			.replace(/\[/g, "{[}")
			.replace(/\]/g, "{]}");
	}

	private mapKey(key: string): string {
		const map: Record<string, string> = {
			enter: "{ENTER}",
			return: "{ENTER}",
			tab: "{TAB}",
			escape: "{ESC}",
			esc: "{ESC}",
			up: "{UP}",
			down: "{DOWN}",
			left: "{LEFT}",
			right: "{RIGHT}",
			backspace: "{BACKSPACE}",
			bksp: "{BACKSPACE}",
			delete: "{DELETE}",
			del: "{DELETE}",
			home: "{HOME}",
			end: "{END}",
			pageup: "{PGUP}",
			pagedown: "{PGDN}",
			space: " ",
			capslock: "{CAPSLOCK}",
			numlock: "{NUMLOCK}",
			scrolllock: "{SCROLLLOCK}",
		};
		// F1-F24
		const fMatch = key.match(/^f(\d+)$/i);
		if (fMatch) {
			const n = Number.parseInt(fMatch[1], 10);
			if (n >= 1 && n <= 24) return `{F${n}}`;
		}
		// Modifier combinations: ctrl+c, alt+tab, shift+a, win+r
		const combo = key.match(/^(ctrl|alt|shift|win)\+(.+)$/i);
		if (combo) {
			const modMap: Record<string, string> = {
				ctrl: "^",
				alt: "%",
				shift: "+",
				win: "^{ESC}",
			};
			const mod = modMap[combo[1].toLowerCase()] || "";
			const subKey = this.mapKey(combo[2]) || combo[2].toUpperCase();
			return `(${mod}${subKey})`;
		}
		// Single printable char
		if (key.length === 1 && key.match(/[a-zA-Z0-9.,;:'"!@#$%^&*()\-_=+]/)) {
			return `{${key.toUpperCase()}}`; // Use {KEY} format for single keys
		}
		return map[key.toLowerCase()] || `{${key.toUpperCase()}}`;
	}
}
