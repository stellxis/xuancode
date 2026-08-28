/**
 * 模式自适应检测器
 *
 * 根据任务特征自动选择最佳执行模式:
 * - standard: 单 Agent 串行，适合强模型+复杂耦合任务
 * - smart: 强模型 + fork_subagent，适合有独立子任务的长任务
 * - local: 弱模型 + 8 子 Agent，适合成本敏感场景
 *
 * 决策优先级: 任务意图 > 字符长度（长度仅做兜底）
 */
export type ModePreset = "standard" | "smart" | "local";

export interface ModeRecommendation {
	mode: ModePreset;
	confidence: number; // 0-1
	reasons: string[];
	suggestedSubAgents: number;
}

/** 任务复杂度特征 */
interface TaskFeatures {
	length: number;
	hasSubTasks: boolean;
	hasFileOps: boolean;
	hasCodeGen: boolean;
	hasSearch: boolean;
	hasReview: boolean;
	hasReportIntent: boolean; // 报告/总结/分析类需求
	hasMultiDocRef: boolean; // 多文件/全域检索需求
	hasComplianceSource: boolean; // 合规/溯源要求
	complexity: number;
}

/** 简单闲聊/接续判断 */
const SIMPLE_CHAT_RE =
	/^(?:你好|hi|hello|嗨|哈[喽罗]|早[上啊]?|晚安|再见|88|bye|在[吗嘛]|嗯|哦|好的?|ok|okay|是的?|对[的嘛]|谢谢|感谢|[再]?见|[听明]?白了?|继续|展开|换说法|简化|扩写|缩短|说人话|懂了|理解|知道了?|可以|不行|算了|没事|没[了什么]|停|停下?|停止|再来|重做|重新|忘了?|忽略|不管[了]?)$/i;

/** 日常简单咨询（单步可完成，不需要 DAG 分解） */
const SIMPLE_QUERY_RE =
	/^(?:查(?:询|一?下|看|找).*?(?:天气|气温|温度|时间|日期|日[期子]|星期|周[几末]|日历|节日|节气|星座|运势|汇率|股价|股票|基金|黄金|油价|路况|地图|导航|公交|地铁|航班|火车|酒店|餐厅|美食|电影|票|新闻|头条|热点)|(?:今天|明天|后天|昨天|现在).*(?:天气|气温|温度|几[点度]|时间)|翻译\s*\S+|(?:把\s*)\S+\s*(?:翻译|译成|转为)\s*(?:成|为)?\s*\S*|(?:\d+\s*[+\-*/×÷]\s*\d+|(?:多少|几).*(?:美元|欧元|日元|英镑|港币|人民币|元|块|斤|公斤|磅|盎司|英寸|厘米|米|公里|平方米|换算|等于))|(?:什么是|什么叫|意思是|什么意思|怎么[用做读说写办]?|如何|怎样|哪里|哪[个些里]|谁|什么[时候地方是])\s*\S*|(?:在吗|在不在|忙吗|有空吗|你好吗|最近[怎么样如何好]|干嘛[呢]?|做什么[呢]?))$/i;

/** 判断是否为纯闲聊/简短接续，应跳过 DAG */
function analyzeTask(input: string): TaskFeatures {
	const indicators = {
		hasSubTasks: /\n(?:然后|接着|同时|另外|再|最后)|(?:首先|第一步|步骤)/,
		hasFileOps:
			/(?:创建|修改|写入|编辑|删除|移动|重命名)\s*.+?(?:文件|目录|文件夹)/,
		hasCodeGen:
			/(?:实现|编写|开发|构建|重构|优化|迁移)\s*.+?(?:函数|类|组件|模块|接口|API|功能)/,
		hasSearch: /(?:搜索|查找|查询|文档|阅读|了解|调研|分析|审查)/,
		hasReview: /(?:审查|检查|审计|测试|Review|review|安全|漏洞|性能)/,
		hasReportIntent:
			/(?:报告|总结|总结|复盘|调研|评估|审计|台账|综述|风险清单|方案文档|验收材料|对比[研判分析]|风险评估|合规[报告]?|分析报告|统计[数据]?|汇总|盘点|梳理|归纳|整理|归档|归档|报备)/,
		hasMultiDocRef:
			/(?:所有|全部|每个|各个|全局|全域|整个|全[部量]?|多处|多处|项目[中内]的|代码库|知识库|历史[会话日志]?|多份|多个文件|批量|逐一|逐条)/,
		hasComplianceSource:
			/(?:标注来源|依据|引用|溯源|客观[数据]?|不能凭空|基于[^0]|参考资料|出处|证据|凭证|截图|佐证|数据支撑)/,
	};

	return {
		length: input.length,
		hasSubTasks: indicators.hasSubTasks.test(input),
		hasFileOps: indicators.hasFileOps.test(input),
		hasCodeGen: indicators.hasCodeGen.test(input),
		hasSearch: indicators.hasSearch.test(input),
		hasReview: indicators.hasReview.test(input),
		hasReportIntent: indicators.hasReportIntent.test(input),
		hasMultiDocRef: indicators.hasMultiDocRef.test(input),
		hasComplianceSource: indicators.hasComplianceSource.test(input),
		complexity: calculateComplexity(input, indicators),
	};
}

/** 判断是否为纯闲聊/简短接续，应跳过 DAG */
function isSimpleChat(input: string): boolean {
	const trimmed = input.trim();
	if (SIMPLE_CHAT_RE.test(trimmed)) return true;
	if (trimmed.length <= 10) {
		const taskIndicators =
			/(?:报告|总结|分析|审查|审计|实现|编写|修复|重构|优化|查找|搜索|整理|评估|排查|调试|部署|打包|构建|测试)/;
		return !taskIndicators.test(trimmed);
	}
	return false;
}

/** 日常简单咨询（天气、翻译、计算等），单步可完成，不应触发 DAG */
function isSimpleQuery(input: string): boolean {
	return SIMPLE_QUERY_RE.test(input.trim());
}

/** 计算综合复杂度 */
function calculateComplexity(
	input: string,
	indicators: Record<string, RegExp>,
): number {
	let score = 0;

	// 长度因子（权重降低：0.3 → 0.15）
	score += Math.min(input.length / 1000, 1) * 0.15;

	// 指示词因子
	const indicatorKeys = Object.keys(indicators);
	let matchCount = 0;
	for (const key of indicatorKeys) {
		if (indicators[key].test(input)) matchCount++;
	}
	score += (matchCount / indicatorKeys.length) * 0.5;

	// 结构因子：含多个段落或步骤
	const paragraphCount = (input.match(/\n\n/g) || []).length + 1;
	const stepCount = (input.match(/\d+[.、]/g) || []).length;
	score += Math.min((paragraphCount + stepCount) / 6, 1) * 0.35;

	return Math.min(score, 1);
}

/**
 * 推荐执行模式
 */
export function recommendMode(
	input: string,
	userPreference?: ModePreset,
): ModeRecommendation {
	if (userPreference) {
		return {
			mode: userPreference,
			confidence: 1,
			reasons: ["用户手动选择"],
			suggestedSubAgents: getDefaultSubAgentCount(userPreference),
		};
	}

	const features = analyzeTask(input);
	const reasons: string[] = [];

	let mode: ModePreset;
	let confidence: number;

	// 报告/分析类 → 优先 smart
	if (features.hasReportIntent || features.hasComplianceSource) {
		mode = features.hasMultiDocRef ? "local" : "smart";
		confidence = 0.85;
		reasons.push("检测到报告/分析类需求");
		if (features.hasMultiDocRef) reasons.push("涉及多文件全域检索");
		if (features.hasComplianceSource) reasons.push("需标注来源与依据");
	} else if (features.complexity < 0.3 && features.length < 200) {
		mode = "standard";
		confidence = 0.9;
		reasons.push("任务较短，逻辑简单");
	} else if (features.complexity >= 0.3 && features.complexity < 0.6) {
		if (features.hasSearch && !features.hasFileOps) {
			mode = "smart";
			confidence = 0.75;
			reasons.push("包含搜索/阅读任务，适合智能模式并行处理");
		} else {
			mode = "standard";
			confidence = 0.7;
			reasons.push("中等复杂度，标准模式更稳妥");
		}
	} else if (features.complexity >= 0.6 && features.complexity < 0.8) {
		if (features.hasSubTasks && (features.hasSearch || features.hasReview)) {
			mode = "smart";
			confidence = 0.8;
			reasons.push("具有多个独立子任务");
			reasons.push("搜索/审查可并行执行不阻塞主流程");
		} else {
			mode = "standard";
			confidence = 0.6;
			reasons.push("高复杂度但步骤耦合紧密");
		}
	} else {
		if (features.hasSubTasks) {
			mode = "local";
			confidence = 0.7;
			reasons.push("极高复杂度任务，推荐并行分解");
			reasons.push("检测到多个独立子步骤");
		} else {
			mode = "smart";
			confidence = 0.5;
			reasons.push("长任务但无明显子步骤边界");
		}
	}

	return {
		mode,
		confidence: Math.round(confidence * 100) / 100,
		reasons,
		suggestedSubAgents: getDefaultSubAgentCount(mode),
	};
}

function getDefaultSubAgentCount(mode: ModePreset): number {
	switch (mode) {
		case "standard":
			return 1;
		case "smart":
			return 4;
		case "local":
			return 8;
	}
}

/**
 * 判断是否应该使用 DAG 拓扑调度
 *
 * 决策层级（优先级从高到低）:
 *   1. 任务意图识别 — 报告/分析/审计等明确需求，无视字符长度
 *   2. 简单闲聊/接续 — 问候、短接续，跳过 DAG
 *   3. 字符长度兜底 — 意图模糊时，长文本尝试 DAG
 *
 * 模式差异:
 *   local:  门槛最低，弱模型靠多 Agent 补强 — 只要不是纯闲聊就 DAG
 *   smart:  意图优先，仅明确复杂任务才 DAG
 *   standard: 原逻辑不变
 */
export function shouldUseDagScheduling(
	input: string,
	modePreset?: ModePreset,
): boolean {
	const features = analyzeTask(input);

	// 闲聊/日常咨询检测（所有模式共用）
	if (isSimpleChat(input)) return false;
	if (isSimpleQuery(input)) return false;

	if (modePreset === "local") {
		// === local 模式: 低门槛触发 ===
		// 有任何实质任务信号 → DAG（门槛远低于 smart）
		if (features.hasReportIntent) return true;
		if (features.hasComplianceSource) return true;
		if (features.hasSearch || features.hasReview) return true;
		if (features.hasSubTasks || features.hasFileOps || features.hasCodeGen)
			return true;
		if (features.hasMultiDocRef) return true;
		// 有长度且非纯代码 → DAG（弱模型分解比硬扛好）
		if (input.length > 50) {
			const codeRatio =
				(input.match(/[{}[\]();:=/\\]/g) || []).length /
				Math.max(input.length, 1);
			if (codeRatio <= 0.05) return true;
		}
		return false;
	}

	// 标准/自动模式: 需要明确实质任务信号，避免误触发
	if (!modePreset || modePreset === "standard") {
		return (
			features.complexity >= 0.6 &&
			features.hasSubTasks &&
			(features.hasCodeGen || features.hasFileOps || features.hasReview)
		);
	}

	// === smart 模式: 意图优先 ===
	// 1. 明确报告/分析/审计意图 → DAG
	if (features.hasReportIntent) return true;
	if (features.hasReview && (features.hasSearch || features.hasFileOps))
		return true;
	if (features.hasSubTasks && (features.hasCodeGen || features.hasFileOps))
		return true;
	if (features.complexity >= 0.6 && features.hasSubTasks) return true;
	if (features.hasComplianceSource) return true;
	if (features.hasMultiDocRef && (features.hasSearch || features.hasReview))
		return true;

	// 兜底：模糊输入时用长度辅助判断
	if (input.length > 150) {
		const codeRatio =
			(input.match(/[{}[\]();:=/\\]/g) || []).length /
			Math.max(input.length, 1);
		if (codeRatio > 0.05) return false;
		return true;
	}

	return false;
}
