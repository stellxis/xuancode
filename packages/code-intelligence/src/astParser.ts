import ts from "typescript";
import type { HttpCallInfo } from "./types";

export interface AstImport {
	/** 模块路径（原始字符串） */
	moduleSpecifier: string;
	/** 具名导入列表 */
	namedImports: string[];
	/** 默认导入名 */
	defaultImport?: string;
	/** 命名空间导入 (import * as X) */
	namespaceImport?: string;
	/** 是否为 type-only import */
	isTypeOnly: boolean;
	/** 是否为动态 import() */
	isDynamic: boolean;
	/** 是否为 re-export (export ... from) */
	isReExport: boolean;
	/** 起始行号（0-based） */
	line: number;
}

export interface AstExport {
	/** 导出名 */
	name: string;
	/** 是否为默认导出 */
	isDefault: boolean;
	/** 是否为 type-only export */
	isTypeOnly: boolean;
	/** 导出类型 */
	kind:
		| "function"
		| "class"
		| "interface"
		| "type"
		| "enum"
		| "variable"
		| "re-export";
	/** 起始行号（0-based） */
	line: number;
}

export interface AstSymbol {
	name: string;
	kind:
		| "function"
		| "class"
		| "interface"
		| "type"
		| "enum"
		| "variable"
		| "method";
	line: number;
	endLine: number;
	isExported: boolean;
}

export interface AstParseResult {
	imports: AstImport[];
	exports: AstExport[];
	symbols: AstSymbol[];
	/** 文件内的 HTTP 请求调用点（fetch/axios/http 等） */
	httpCalls: HttpCallInfo[];
	/** 提取的模块路径列表（兼容旧接口） */
	importPaths: string[];
}

/**
 * 使用 TypeScript Compiler API 精确解析 TS/JS/TSX/JSX 文件。
 * 相比正则方案，能正确处理：
 * - 具名导入/导出
 * - 动态 import()
 * - re-export
 * - type-only import/export
 * - 嵌套作用域中的符号
 */
export function parseWithAst(
	filePath: string,
	content: string,
): AstParseResult {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const isJsx = ext === "jsx" || ext === "tsx";
	const scriptKind = isJsx
		? ext === "tsx"
			? ts.ScriptKind.TSX
			: ts.ScriptKind.JSX
		: ext === "ts"
			? ts.ScriptKind.TS
			: ts.ScriptKind.JS;

	const sourceFile = ts.createSourceFile(
		filePath,
		content,
		ts.ScriptTarget.Latest,
		true,
		scriptKind,
	);

	const imports: AstImport[] = [];
	const exports: AstExport[] = [];
	const symbols: AstSymbol[] = [];
	const httpCalls: HttpCallInfo[] = [];

	function getLine(node: ts.Node): number {
		return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
	}

	function getEndLine(node: ts.Node): number {
		return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
	}

	function hasExportModifier(node: ts.Node): boolean {
		if (!ts.canHaveModifiers(node)) return false;
		const modifiers = ts.getModifiers(node);
		return (
			modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
		);
	}

	function hasDefaultModifier(node: ts.Node): boolean {
		if (!ts.canHaveModifiers(node)) return false;
		const modifiers = ts.getModifiers(node);
		return (
			modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false
		);
	}

	// ---- HTTP 调用检测 ----
	const HTTP_BASES = new Set([
		"fetch",
		"axios",
		"request",
		"superagent",
		"http",
		"https",
		"ky",
		"$http",
	]);
	const HTTP_METHOD_PROPS = new Set([
		"get",
		"post",
		"put",
		"delete",
		"patch",
		"head",
		"options",
	]);

	function staticString(n: ts.Node | undefined): string | null {
		if (!n) return null;
		if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
			return n.text;
		}
		return null;
	}

	/** 从对象字面量中取指定属性的静态字符串值 */
	function objectPropString(
		obj: ts.Node | undefined,
		key: string,
	): string | null {
		if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
		for (const prop of obj.properties) {
			if (
				ts.isPropertyAssignment(prop) &&
				prop.name &&
				(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
				prop.name.text === key
			) {
				return staticString(prop.initializer);
			}
		}
		return null;
	}

	/** 识别 fetch/axios/http 等 HTTP 调用，提取方法与 URL */
	function tryExtractHttpCall(node: ts.CallExpression): HttpCallInfo | null {
		const expr = node.expression;
		let callee = "";
		let method: string | null = null;
		let urlNode: ts.Expression | undefined;
		let configNode: ts.Expression | undefined;

		if (ts.isIdentifier(expr)) {
			const name = expr.text;
			if (!HTTP_BASES.has(name)) return null;
			callee = name;
			const a0 = node.arguments[0];
			if (name === "axios") {
				// axios(url[, config]) 或 axios(config)
				if (a0 && (ts.isStringLiteral(a0) || ts.isTemplateLiteral(a0))) {
					urlNode = a0;
					configNode = node.arguments[1];
				} else {
					configNode = a0;
				}
			} else {
				urlNode = a0;
				configNode = node.arguments[1];
			}
		} else if (ts.isPropertyAccessExpression(expr)) {
			const prop = expr.name.text;
			const objText = expr.expression.getText(sourceFile);
			const base = objText.split(".").pop() ?? objText;
			if (!HTTP_BASES.has(base)) return null;
			if (prop === "request") {
				callee = `${base}.request`;
				configNode = node.arguments[0];
			} else if (HTTP_METHOD_PROPS.has(prop)) {
				callee = `${base}.${prop}`;
				method = prop.toUpperCase();
				urlNode = node.arguments[0];
				configNode = node.arguments[1];
			} else {
				return null; // axios.create / http.createServer 等非请求调用
			}
		} else {
			return null;
		}

		const url = staticString(urlNode) ?? objectPropString(configNode, "url");
		if (!method) {
			method = objectPropString(configNode, "method")?.toUpperCase() ?? "GET";
		}

		return { callee, method, url, line: getLine(node) };
	}

	function visit(node: ts.Node): void {
		// Import declarations: import ... from "..."
		if (ts.isImportDeclaration(node)) {
			const moduleSpecifier = ts.isStringLiteral(node.moduleSpecifier)
				? node.moduleSpecifier.text
				: "";
			if (!moduleSpecifier) return;

			const imp: AstImport = {
				moduleSpecifier,
				namedImports: [],
				isTypeOnly: node.importClause?.isTypeOnly ?? false,
				isDynamic: false,
				isReExport: false,
				line: getLine(node),
			};

			const clause = node.importClause;
			if (clause) {
				if (clause.name) {
					imp.defaultImport = clause.name.text;
				}
				if (clause.namedBindings) {
					if (ts.isNamespaceImport(clause.namedBindings)) {
						imp.namespaceImport = clause.namedBindings.name.text;
					} else if (ts.isNamedImports(clause.namedBindings)) {
						for (const el of clause.namedBindings.elements) {
							imp.namedImports.push(el.name.text);
						}
					}
				}
			}

			imports.push(imp);
		}

		// Export declarations with module specifier (re-export): export ... from "..."
		if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			const moduleSpecifier = ts.isStringLiteral(node.moduleSpecifier)
				? node.moduleSpecifier.text
				: "";
			if (moduleSpecifier) {
				const imp: AstImport = {
					moduleSpecifier,
					namedImports: [],
					isTypeOnly: node.isTypeOnly,
					isDynamic: false,
					isReExport: true,
					line: getLine(node),
				};
				if (node.exportClause && ts.isNamedExports(node.exportClause)) {
					for (const el of node.exportClause.elements) {
						imp.namedImports.push(el.name.text);
					}
				}
				imports.push(imp);
			}
		}

		// Dynamic import: import("...")
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			imports.push({
				moduleSpecifier: (node.arguments[0] as ts.StringLiteral).text,
				namedImports: [],
				isTypeOnly: false,
				isDynamic: true,
				isReExport: false,
				line: getLine(node),
			});
		}

		// HTTP 请求调用检测（fetch/axios/http 等）→ 接口调用链路数据源
		if (ts.isCallExpression(node)) {
			const httpCall = tryExtractHttpCall(node);
			if (httpCall) httpCalls.push(httpCall);
		}

		// Function declarations
		if (ts.isFunctionDeclaration(node) && node.name) {
			const isExported = hasExportModifier(node);
			symbols.push({
				name: node.name.text,
				kind: "function",
				line: getLine(node),
				endLine: getEndLine(node),
				isExported,
			});
			if (isExported) {
				exports.push({
					name: node.name.text,
					isDefault: hasDefaultModifier(node),
					isTypeOnly: false,
					kind: "function",
					line: getLine(node),
				});
			}
		}

		// Class declarations
		if (ts.isClassDeclaration(node) && node.name) {
			const isExported = hasExportModifier(node);
			symbols.push({
				name: node.name.text,
				kind: "class",
				line: getLine(node),
				endLine: getEndLine(node),
				isExported,
			});
			if (isExported) {
				exports.push({
					name: node.name.text,
					isDefault: hasDefaultModifier(node),
					isTypeOnly: false,
					kind: "class",
					line: getLine(node),
				});
			}
			// Visit class members for methods
			for (const member of node.members) {
				if (ts.isMethodDeclaration(member) && member.name) {
					const methodName = member.name.getText(sourceFile);
					symbols.push({
						name: `${node.name.text}.${methodName}`,
						kind: "method",
						line: getLine(member),
						endLine: getEndLine(member),
						isExported: false,
					});
				}
			}
		}

		// Interface declarations
		if (ts.isInterfaceDeclaration(node)) {
			const isExported = hasExportModifier(node);
			symbols.push({
				name: node.name.text,
				kind: "interface",
				line: getLine(node),
				endLine: getEndLine(node),
				isExported,
			});
			if (isExported) {
				exports.push({
					name: node.name.text,
					isDefault: false,
					isTypeOnly: true,
					kind: "interface",
					line: getLine(node),
				});
			}
		}

		// Type alias declarations
		if (ts.isTypeAliasDeclaration(node)) {
			const isExported = hasExportModifier(node);
			symbols.push({
				name: node.name.text,
				kind: "type",
				line: getLine(node),
				endLine: getEndLine(node),
				isExported,
			});
			if (isExported) {
				exports.push({
					name: node.name.text,
					isDefault: false,
					isTypeOnly: true,
					kind: "type",
					line: getLine(node),
				});
			}
		}

		// Enum declarations
		if (ts.isEnumDeclaration(node)) {
			const isExported = hasExportModifier(node);
			symbols.push({
				name: node.name.text,
				kind: "enum",
				line: getLine(node),
				endLine: getEndLine(node),
				isExported,
			});
			if (isExported) {
				exports.push({
					name: node.name.text,
					isDefault: false,
					isTypeOnly: false,
					kind: "enum",
					line: getLine(node),
				});
			}
		}

		// Variable statements (const/let/var with arrow functions or values)
		if (ts.isVariableStatement(node)) {
			const isExported = hasExportModifier(node);
			for (const decl of node.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) {
					const name = decl.name.text;
					const isFunc =
						decl.initializer &&
						(ts.isArrowFunction(decl.initializer) ||
							ts.isFunctionExpression(decl.initializer));
					symbols.push({
						name,
						kind: isFunc ? "function" : "variable",
						line: getLine(decl),
						endLine: getEndLine(decl),
						isExported,
					});
					if (isExported) {
						exports.push({
							name,
							isDefault: false,
							isTypeOnly: false,
							kind: isFunc ? "function" : "variable",
							line: getLine(decl),
						});
					}
				}
			}
		}

		// Export assignment: export default <expr>
		if (ts.isExportAssignment(node) && !node.isExportEquals) {
			exports.push({
				name: "default",
				isDefault: true,
				isTypeOnly: false,
				kind: "variable",
				line: getLine(node),
			});
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

	return {
		imports,
		exports,
		symbols,
		httpCalls,
		importPaths: [...new Set(imports.map((i) => i.moduleSpecifier))],
	};
}
