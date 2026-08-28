/**
 * 轻量级 Cron 表达式解析与匹配
 *
 * 支持标准 5 段 cron: minute hour day-of-month month day-of-week
 * 语法: 通配符 *, 范围 1-5, 步进星号/5, 列表 1,3,5
 *
 * 无秒字段 (不支援 @yearly / @weekly 等别名)
 */

export interface CronFields {
	minute: number[];
	hour: number[];
	dayOfMonth: number[];
	month: number[];
	dayOfWeek: number[];
}

function parseField(value: string, min: number, max: number): number[] | null {
	const result: number[] = [];

	// 逗号分隔的列表
	const parts = value.split(",");
	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) return null;

		let step = 1;
		let rangePart = trimmed;

		// 步进解析: */5 或 1-10/2
		const stepIdx = trimmed.indexOf("/");
		if (stepIdx !== -1) {
			const stepStr = trimmed.slice(stepIdx + 1);
			const parsedStep = Number.parseInt(stepStr, 10);
			if (Number.isNaN(parsedStep) || parsedStep < 1) return null;
			step = parsedStep;
			rangePart = trimmed.slice(0, stepIdx);
		}

		if (rangePart === "*") {
			for (let i = min; i <= max; i += step) result.push(i);
		} else if (rangePart.includes("-")) {
			const dashIdx = rangePart.indexOf("-");
			const rangeStart = Number.parseInt(rangePart.slice(0, dashIdx), 10);
			const rangeEnd = Number.parseInt(rangePart.slice(dashIdx + 1), 10);
			if (Number.isNaN(rangeStart) || Number.isNaN(rangeEnd)) return null;
			if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd)
				return null;
			for (let i = rangeStart; i <= rangeEnd; i += step) result.push(i);
		} else {
			const val = Number.parseInt(rangePart, 10);
			if (Number.isNaN(val) || val < min || val > max) return null;
			result.push(val);
		}
	}

	return [...new Set(result)].sort((a, b) => a - b);
}

const MONTH_NAMES: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};
const DOW_NAMES: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

function normalizeField(field: string, names: Record<string, number>): string {
	const lower = field.toLowerCase();
	for (const [name, val] of Object.entries(names)) {
		if (lower === name) return String(val);
		// 替换字符串中的名称 (如 "1-5" 不变, "mon-fri" → "1-5")
		const replaced = lower.replace(new RegExp(name, "g"), String(val));
		if (replaced !== lower) return replaced;
	}
	return field;
}

/**
 * 解析 cron 表达式。返回 null 表示非法表达式。
 */
export function parseCron(expr: string): CronFields | null {
	const trimmed = expr.trim();
	if (!trimmed) return null;

	const fields = trimmed.split(/\s+/);
	if (fields.length !== 5) return null;

	const [minuteStr, hourStr, domStr, monthStr, dowStr] = fields;

	const monthNormalized = normalizeField(monthStr, MONTH_NAMES);
	const dowNormalized = normalizeField(dowStr, DOW_NAMES);

	const minute = parseField(minuteStr, 0, 59);
	const hour = parseField(hourStr, 0, 23);
	const dayOfMonth = parseField(domStr, 1, 31);
	const month = parseField(monthNormalized, 1, 12);
	const dayOfWeek = parseField(dowNormalized, 0, 6);

	if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;

	return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/**
 * 检查指定日期是否匹配 cron 表达式
 */
export function cronMatches(fields: CronFields, date: Date): boolean {
	const m = date.getMonth() + 1; // JS month 0-based → 1-based
	const d = date.getDate();
	const h = date.getHours();
	const min = date.getMinutes();
	const dow = date.getDay(); // 0=Sun

	if (!fields.month.includes(m)) return false;
	if (!fields.dayOfMonth.includes(d) && !fields.dayOfWeek.includes(dow))
		return false;
	if (!fields.hour.includes(h)) return false;
	if (!fields.minute.includes(min)) return false;

	return true;
}

/**
 * 计算自 from 之后的下一次执行时间戳（毫秒）
 * 搜索范围最大 366 天
 */
export function getNextRunTime(
	fields: CronFields,
	from: Date = new Date(),
): number | null {
	const MAX_CHECK = 366 * 24 * 60; // 366 天的分钟数
	let checked = 0;
	const cursor = new Date(from);

	// 从下一分钟开始检查
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);

	while (checked < MAX_CHECK) {
		if (cronMatches(fields, cursor)) {
			return cursor.getTime();
		}
		cursor.setMinutes(cursor.getMinutes() + 1);
		checked++;
	}

	return null;
}

/**
 * 生成 cron 表达式的人类可读描述（中文）
 */
export function describeCron(expr: string): string {
	const fields = parseCron(expr);
	if (!fields) return "无效表达式";

	const { minute, hour, dayOfMonth, month, dayOfWeek } = fields;

	const everyMin = minute.length >= 60;
	const everyHour = hour.length >= 24;
	const everyDay = dayOfMonth.length >= 31;
	const everyMonth = month.length >= 12;
	const everyDow = dayOfWeek.length >= 7;

	const minStr = fmtList(minute, "分");
	const hourStr = fmtList(hour, "时");

	// 每分钟
	if (everyMin && everyHour && everyDay && everyMonth) return "每分钟";

	// 每小时
	if (everyHour && everyDay && everyMonth && !everyMin)
		return `每小时的第 ${minStr}`;

	// 每天固定时间
	if (everyDay && everyMonth && !everyHour && !everyMin) {
		return `每天 ${hourStr}:${fmtMin(minute)}`;
	}

	// 每周固定时间
	if (everyMonth && !everyDay && !everyHour && !everyMin) {
		const days = dayOfWeek
			.map((d) => ["日", "一", "二", "三", "四", "五", "六"][d])
			.join("、");
		return `每周${days} ${hourStr}:${fmtMin(minute)}`;
	}

	// 每月固定日期
	if (everyMonth && !everyDay && !everyHour && !everyMin) {
		return `每月 ${fmtList(dayOfMonth, "号")} ${hourStr}:${fmtMin(minute)}`;
	}

	// 步进检测
	if (
		minute.length === 1 &&
		minute[0] > 0 &&
		minute[0] < 60 &&
		hour.length >= 24 &&
		dayOfMonth.length >= 31 &&
		month.length >= 12
	) {
		return `每 ${minute[0]} 分钟`;
	}

	return `cron: ${expr}`;
}

function fmtList(arr: number[], unit: string): string {
	if (arr.length <= 3) return arr.join(", ") + unit;
	return `${arr[0]}-${arr[arr.length - 1]}${unit}`;
}

function fmtMin(minute: number[]): string {
	return minute.map((m) => String(m).padStart(2, "0")).join(", ");
}
