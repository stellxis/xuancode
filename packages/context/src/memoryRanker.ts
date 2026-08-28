import type { MemoryItem, MemoryRankOptions } from "@xuancode/types";

/**
 * Lightweight keyword-based memory ranker.
 * No embeddings or external services — pure token overlap + time decay.
 */

export interface ScoredItem {
	item: MemoryItem;
	score: number;
}

/**
 * Score items against a query, returning sorted + filtered results.
 */
export function scoreItems(
	items: MemoryItem[],
	query: string,
	options?: Partial<MemoryRankOptions>,
): ScoredItem[] {
	const opts: MemoryRankOptions = {
		topK: options?.topK ?? 15,
		minScore: options?.minScore ?? 0.05,
		decayLambda: options?.decayLambda ?? 0.01,
	};

	const scored = items.map((item) => {
		if (item.pinned) {
			return { item, score: 1.0 };
		}

		const relevance = keywordOverlapScore(query, item.text);
		const tagBonus = tagMatchScore(query, item.tags);
		const daysSinceAccess = (Date.now() - item.lastAccessedAt) / 86_400_000;
		const decay = Math.exp(-opts.decayLambda * daysSinceAccess);
		const finalScore = (relevance + tagBonus) * item.weight * decay;

		return { item, score: finalScore };
	});

	return scored
		.filter((s) => s.score >= opts.minScore)
		.sort((a, b) => b.score - a.score)
		.slice(0, opts.topK);
}

/** Jaccard similarity between two strings (word-level) */
export function jaccardSimilarity(a: string, b: string): number {
	const setA = new Set(tokenize(a));
	const setB = new Set(tokenize(b));
	if (setA.size === 0 && setB.size === 0) return 0;
	const intersection = new Set([...setA].filter((w) => setB.has(w)));
	const union = new Set([...setA, ...setB]);
	return intersection.size / union.size;
}

/** Keyword overlap: |query ∩ item| / max(|query|, |item|) */
export function keywordOverlapScore(query: string, text: string): number {
	const queryTokens = tokenize(query);
	const textTokens = tokenize(text);
	if (queryTokens.length === 0 || textTokens.length === 0) return 0;
	const textSet = new Set(textTokens);
	const overlap = queryTokens.filter((w) => textSet.has(w)).length;
	return overlap / Math.max(queryTokens.length, textTokens.length);
}

/** Tag match bonus: +0.2 per matching tag keyword found in query */
export function tagMatchScore(query: string, tags: string[]): number {
	const qLower = query.toLowerCase();
	return tags.filter((t) => qLower.includes(t)).length * 0.2;
}

/** Infer tags from text content using keyword heuristics */
export function inferTags(text: string): string[] {
	const lower = text.toLowerCase();
	const tags: string[] = [];
	if (
		lower.includes("prefer") ||
		lower.includes("like") ||
		lower.includes("习惯") ||
		lower.includes("喜欢")
	)
		tags.push("preference");
	if (
		lower.includes("decision") ||
		lower.includes("choose") ||
		lower.includes("决定") ||
		lower.includes("选择") ||
		lower.includes("选")
	)
		tags.push("decision");
	if (
		lower.includes("constraint") ||
		lower.includes("must") ||
		lower.includes("cannot") ||
		lower.includes("不能") ||
		lower.includes("必须") ||
		lower.includes("禁止")
	)
		tags.push("constraint");
	if (
		lower.includes("pattern") ||
		lower.includes("convention") ||
		lower.includes("约定") ||
		lower.includes("模式") ||
		lower.includes("套路")
	)
		tags.push("pattern");
	if (tags.length === 0) tags.push("preference");
	return tags;
}

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"need",
	"dare",
	"ought",
	"used",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"out",
	"off",
	"over",
	"under",
	"again",
	"further",
	"then",
	"once",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"nor",
	"not",
	"only",
	"own",
	"same",
	"so",
	"than",
	"too",
	"very",
	"just",
	"because",
	"but",
	"and",
	"or",
	"if",
	"while",
	"about",
	"up",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"we",
	"you",
	"he",
	"him",
	"his",
	"she",
	"her",
	"they",
	"them",
	"their",
	"what",
	"which",
	"who",
	"whom",
	"whose",
	"的",
	"了",
	"在",
	"是",
	"我",
	"有",
	"和",
	"就",
	"不",
	"人",
	"都",
	"一",
	"一个",
	"上",
	"也",
	"很",
	"到",
	"说",
	"要",
	"去",
	"你",
	"会",
	"着",
	"没有",
	"看",
	"好",
	"自己",
	"这",
	"他",
	"她",
	"它",
	"们",
]);

/** Tokenize: lowercase, split on non-alpha (supports Chinese), filter stop words + short tokens */
export function tokenize(text: string): string[] {
	// Split into tokens on non-alpha characters (Latin + CJK characters kept)
	const rawTokens = text
		.toLowerCase()
		.split(/[^a-zÀ-ɏ一-鿿]+/)
		.filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

	// For Chinese text, also generate bigrams for better matching
	const cjkRe = /^[一-鿿]+$/;
	const bigrams: string[] = [];
	for (const token of rawTokens) {
		if (cjkRe.test(token) && token.length > 2) {
			for (let i = 0; i < token.length - 1; i++) {
				bigrams.push(token.slice(i, i + 2));
			}
		}
	}

	return [...rawTokens, ...bigrams];
}
