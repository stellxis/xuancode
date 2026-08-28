import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// 单一版本源：构建时从 package.json 注入，npm 包与 pkg 二进制共用同一 bundle 均生效
const pkg = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

// 纯 JS 核心包：打进单文件 bundle，npm 发布自包含，无 workspace 解析依赖
const NO_EXTERNAL = [
	"@xuancode/daemon-protocol",
	"@xuancode/types",
	"@xuancode/utils",
	"@xuancode/context",
	"@xuancode/model-adapter",
	"@xuancode/orchestrator",
	"@xuancode/subagent",
	"@xuancode/session",
	"@xuancode/tools",
	"@xuancode/permission",
	"@xuancode/distiller",
	"@xuancode/database",
];

// client-only：内嵌 daemon 不随 npm 发布；better-sqlite3 为原生模块，需运行时安装；
// execa 为 ESM、cross-spawn 为 CJS(内部动态 require child_process)——内联进 ESM bundle 会触发
// "Dynamic require" 运行时崩溃，必须保留在 node_modules 由 Node 原生加载
const EXTERNAL = ["@xuancode/daemon", "better-sqlite3", "execa", "cross-spawn"];

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	outDir: "dist",
	clean: true,
	noExternal: NO_EXTERNAL,
	external: EXTERNAL,
	define: {
		__XUANCODE_VERSION__: JSON.stringify(pkg.version),
	},
});
