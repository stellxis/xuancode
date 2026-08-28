import { parseWithAst } from "./astParser";
import type { CodeChunk } from "./types";
import { LANGUAGE_MAP } from "./types";

const STOP_WORDS = new Set([
	"the",
	"this",
	"that",
	"and",
	"or",
	"for",
	"with",
	"from",
	"function",
	"var",
	"let",
	"const",
	"return",
	"if",
	"else",
	"while",
	"for",
	"do",
	"switch",
	"case",
	"break",
	"continue",
	"try",
	"catch",
	"finally",
	"throw",
	"new",
	"class",
	"interface",
	"type",
	"enum",
	"extends",
	"implements",
	"export",
	"import",
	"default",
	"async",
	"await",
	"yield",
	"typeof",
	"instanceof",
	"void",
	"null",
	"undefined",
	"true",
	"false",
	"string",
	"number",
	"boolean",
	"any",
	"never",
	"unknown",
	"public",
	"private",
	"protected",
	"static",
	"readonly",
	"abstract",
]);

const STOP_WORDS_ZH = new Set([
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

const PATTERN_FUNCTIONS = [
	/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
	/(?:export\s+)?(?:async\s+)?(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\w+)?\s*=>/g,
	/(?:export\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/g,
];

const PATTERN_CLASSES = [
	/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g,
	/(?:export\s+)?interface\s+(\w+)/g,
	/(?:export\s+)?type\s+(\w+)\s*=/g,
	/(?:export\s+)?enum\s+(\w+)/g,
];

const IMPORT_PATTERNS_JS = [
	/import\s+(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']/g,
	/require\(["']([^"']+)["']\)/g,
];

export function tokenize(content: string): string[] {
	const tokens: string[] = [];
	const cleaned = content.toLowerCase();

	const rawTokens = cleaned.split(/[^a-zA-Z0-9_一-鿿]+/).filter(Boolean);

	for (const token of rawTokens) {
		if (token.length < 2) continue;
		if (STOP_WORDS.has(token)) continue;
		if (STOP_WORDS_ZH.has(token)) continue;

		tokens.push(token);

		if (/^[a-z]/.test(token)) {
			const parts = token.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
			for (const part of parts) {
				if (part.length >= 3 && !STOP_WORDS.has(part)) {
					tokens.push(part.toLowerCase());
				}
			}
		}
	}

	return [...new Set(tokens)];
}

export function extractImports(content: string, ext: string): string[] {
	const lang = LANGUAGE_MAP[ext] || "";

	if (["typescript", "javascript"].includes(lang)) {
		// 优先使用 TypeScript Compiler API 精确解析（具名导入、动态 import、re-export 等）
		try {
			const result = parseWithAst(`file.${ext}`, content);
			if (result.importPaths.length > 0) return result.importPaths;
		} catch {
			// AST 解析失败时回退到正则
		}
		const imports: string[] = [];
		for (const pattern of IMPORT_PATTERNS_JS) {
			const matches = content.matchAll(pattern);
			for (const m of matches) {
				imports.push(m[1]);
			}
		}
		return [...new Set(imports)];
	}

	const imports: string[] = [];
	if (lang === "python") {
		const pyPatterns = [/^import\s+(\S+)/gm, /^from\s+(\S+)\s+import/gm];
		for (const pattern of pyPatterns) {
			const matches = content.matchAll(pattern);
			for (const m of matches) {
				imports.push(m[1]);
			}
		}
	} else if (lang === "go") {
		const goMatch = content.matchAll(/"([^"]+)"/g);
		for (const m of goMatch) {
			if (m[1].includes("/") || m[1].includes(".")) {
				imports.push(m[1]);
			}
		}
	} else if (lang === "rust") {
		const rsMatch = content.matchAll(/^use\s+(\S+)/gm);
		for (const m of rsMatch) {
			imports.push(m[1]);
		}
	} else if (lang === "java") {
		const javaMatch = content.matchAll(/^import\s+(\S+)/gm);
		for (const m of javaMatch) {
			imports.push(m[1]);
		}
	}

	return [...new Set(imports)];
}

function getFileType(name: string): CodeChunk["type"] {
	const ext = name.split(".").pop()?.toLowerCase();
	if (
		ext === "css" ||
		ext === "scss" ||
		ext === "json" ||
		ext === "yaml" ||
		ext === "yml" ||
		ext === "md"
	) {
		return "file";
	}
	return "file";
}

export function chunkFile(filePath: string, content: string): CodeChunk[] {
	const chunks: CodeChunk[] = [];
	const lines = content.split("\n");
	const ext = filePath.split(".").pop() || "";
	const fileName = filePath.split("/").pop() || filePath;

	const allTokens = tokenize(content);

	// TS/JS 优先做一次 AST 解析，imports / httpCalls / symbols 共用同一结果
	const lang = LANGUAGE_MAP[ext] || "";
	let ast: ReturnType<typeof parseWithAst> | null = null;
	if (["typescript", "javascript"].includes(lang)) {
		try {
			ast = parseWithAst(filePath, content);
		} catch {
			ast = null;
		}
	}

	const allImports = ast ? ast.importPaths : extractImports(content, ext);

	const fileChunk: CodeChunk = {
		id: hashString(`${filePath}:0`),
		filePath,
		startLine: 0,
		endLine: Math.min(lines.length, 40),
		type: getFileType(fileName),
		name: fileName,
		content: lines.slice(0, Math.min(lines.length, 40)).join("\n"),
		tokens: allTokens,
		imports: allImports,
	};
	// 文件级 chunk 携带 HTTP 调用点，供接口调用链路追踪
	if (ast && ast.httpCalls.length > 0) {
		fileChunk.httpCalls = ast.httpCalls;
	}
	chunks.push(fileChunk);

	// TS/JS 使用 AST 精确提取符号（函数/类/接口/类型/枚举）
	if (ast) {
		for (const sym of ast.symbols) {
			// 跳过 method（已作为类成员内联），仅保留顶层符号
			if (sym.kind === "method") continue;
			if (sym.name === fileName.replace(/\.[^.]+$/, "")) continue;

			const type: CodeChunk["type"] =
				sym.kind === "function"
					? "function"
					: sym.kind === "class"
						? "class"
						: sym.kind === "interface"
							? "interface"
							: sym.kind === "enum"
								? "class"
								: "type";

			const startLine = sym.line;
			const endLine = Math.min(sym.endLine, lines.length - 1);
			const chunkContent = lines.slice(startLine, endLine + 1).join("\n");

			chunks.push({
				id: hashString(`${filePath}:${startLine}-${sym.name}`),
				filePath,
				startLine,
				endLine,
				type,
				name: sym.name,
				content: chunkContent,
				tokens: tokenize(chunkContent),
				imports: extractImports(chunkContent, ext),
			});
		}
		return chunks;
	}

	for (const pattern of PATTERN_CLASSES) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while (true) {
			match = pattern.exec(content);
			if (match === null) break;
			const name = match[1];
			const pos = content.substring(0, match.index).split("\n").length;

			let braceDepth = 0;
			let endPos = match.index;
			let started = false;
			for (let i = match.index; i < content.length; i++) {
				const ch = content[i];
				if (ch === "{" || ch === "(") {
					braceDepth++;
					started = true;
				} else if (ch === "}" || ch === ")") {
					braceDepth--;
				}
				if (started && braceDepth === 0 && (ch === "}" || ch === ")")) {
					endPos = i + 1;
					break;
				}
				endPos = i + 1;
			}
			const endLine = content.substring(0, endPos).split("\n").length - 1;
			const chunkContent = lines.slice(pos - 1, endLine + 1).join("\n");

			chunks.push({
				id: hashString(`${filePath}:${pos}`),
				filePath,
				startLine: pos - 1,
				endLine,
				type: content.substring(match.index).startsWith("class")
					? "class"
					: content.substring(match.index).startsWith("interface")
						? "interface"
						: "type",
				name,
				content: chunkContent,
				tokens: tokenize(chunkContent),
				imports: extractImports(chunkContent, ext),
			});
		}
	}

	for (const pattern of PATTERN_FUNCTIONS) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while (true) {
			match = pattern.exec(content);
			if (match === null) break;
			const name = match[1];
			const pos = content.substring(0, match.index).split("\n").length;

			if (
				chunks.some((c) => c.name === name && Math.abs(c.startLine - pos) < 3)
			)
				continue;

			let braceDepth = 0;
			let endPos = match.index;
			let started = false;
			for (let i = match.index; i < content.length; i++) {
				const ch = content[i];
				if (ch === "{") {
					braceDepth++;
					started = true;
				} else if (ch === "}") {
					braceDepth--;
				}
				if (started && braceDepth === 0 && ch === "}") {
					endPos = i + 1;
					break;
				}
				endPos = i + 1;
			}
			const endLine = content.substring(0, endPos).split("\n").length - 1;
			const chunkContent = lines.slice(pos - 1, endLine + 1).join("\n");

			if (name !== fileName.replace(/\.[^.]+$/, "")) {
				chunks.push({
					id: hashString(`${filePath}:${pos}-func`),
					filePath,
					startLine: pos - 1,
					endLine,
					type: "function",
					name,
					content: chunkContent,
					tokens: tokenize(chunkContent),
					imports: extractImports(chunkContent, ext),
				});
			}
		}
	}

	return chunks;
}

function hashString(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return Math.abs(hash).toString(36) + str.length.toString(36);
}
