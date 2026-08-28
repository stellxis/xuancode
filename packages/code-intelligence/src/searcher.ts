import type { CodeIndex, SearchResult } from "./types";

export function search(
	index: CodeIndex,
	query: string,
	topK = 10,
): SearchResult[] {
	const queryTokens = tokenizeQuery(query);
	if (queryTokens.length === 0) return [];

	const totalChunks = index.chunks.length;
	const scores = new Map<string, { score: number; matchedTokens: string[] }>();

	for (const chunk of index.chunks) {
		scores.set(chunk.id, { score: 0, matchedTokens: [] });
	}

	for (const qToken of queryTokens) {
		const matchingIds = index.invertedIndex.get(qToken);
		if (!matchingIds) continue;

		const idf =
			Math.log((totalChunks + 1) / ((index.docFreq.get(qToken) || 0) + 1)) + 1;

		const idCount = new Map<string, number>();
		for (const id of matchingIds) {
			idCount.set(id, (idCount.get(id) || 0) + 1);
		}

		for (const [id, count] of idCount) {
			const chunk = index.chunks.find((c) => c.id === id);
			if (!chunk) continue;

			const tf = count / Math.max(chunk.tokens.length, 1);
			const existing = scores.get(id)!;
			existing.score += tf * idf;
			existing.matchedTokens.push(qToken);
		}
	}

	const results: SearchResult[] = [];
	for (const chunk of index.chunks) {
		const s = scores.get(chunk.id)!;
		if (s.score > 0) {
			results.push({
				chunk,
				score: s.score,
				matchType: "keyword",
				matchedTokens: [...new Set(s.matchedTokens)],
			});
		}
	}

	results.sort((a, b) => b.score - a.score);

	if (results.length > topK) {
		const maxScore = results[0].score;
		if (maxScore > 0) {
			for (const r of results) {
				r.score = r.score / maxScore;
			}
		}
		return results.slice(0, topK);
	}

	const maxScore = results[0]?.score || 1;
	for (const r of results) {
		r.score = r.score / maxScore;
	}

	return results;
}

export function searchWithContext(
	index: CodeIndex,
	query: string,
	contextPath?: string,
	topK = 10,
): SearchResult[] {
	const results = search(index, query, topK * 2);

	if (contextPath) {
		const contextDir = contextPath.split("/").slice(0, -1).join("/");
		for (const r of results) {
			const resultDir = r.chunk.filePath.split("/").slice(0, -1).join("/");
			if (resultDir === contextDir) {
				r.score *= 1.3;
			} else if (
				resultDir.startsWith(contextDir) ||
				contextDir.startsWith(resultDir)
			) {
				r.score *= 1.1;
			}
		}
		results.sort((a, b) => b.score - a.score);
	}

	return results.slice(0, topK);
}

function tokenizeQuery(query: string): string[] {
	const tokens: string[] = [];

	const tokensWithCase = query.split(/[^a-zA-Z0-9_一-鿿]+/).filter(Boolean);

	for (const token of tokensWithCase) {
		if (token.length < 2) continue;

		if (isASCII(token)) {
			tokens.push(token.toLowerCase());
			tokens.push(token);

			const parts = token.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
			for (const part of parts) {
				if (part.length >= 2) {
					tokens.push(part.toLowerCase());
				}
			}
		} else {
			tokens.push(token);
		}
	}

	return [...new Set(tokens)];
}

function isASCII(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		if (str.charCodeAt(i) > 0x7f) return false;
	}
	return true;
}
