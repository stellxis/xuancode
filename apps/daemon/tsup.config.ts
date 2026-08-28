import { defineConfig } from "tsup";

const SHARED_NO_EXTERNAL = [
	"dotenv",
	"@xuancode/daemon-protocol",
	"@xuancode/types",
	"@xuancode/orchestrator",
	"@xuancode/model-adapter",
	"@xuancode/tools",
	"@xuancode/permission",
	"@xuancode/session",
	"@xuancode/context",
	"@xuancode/plugins",
	"@xuancode/model-router",
	"@xuancode/mcp-server",
	"@xuancode/a2a",
	"@xuancode/telemetry",
	"@xuancode/optimizer",
	"@xuancode/code-intelligence",
	"@xuancode/database",
	"@xuancode/indexer",
	"@xuancode/distiller",
	"@xuancode/plugin-serpapi",
	"@xuancode/plugin-duckduckgo",
	"@xuancode/plugin-searxng",
	"screenshot-desktop",
];

const EXTERNAL_NATIVE = ["better-sqlite3", "@parcel/watcher", "pg"];

export default defineConfig([
	// Command Center (main entry — spawns worker units)
	{
		entry: ["src/index.ts"],
		format: "cjs",
		outDir: "../desktop/dist-daemon",
		splitting: false,
		clean: false,
		shims: true,
		noExternal: SHARED_NO_EXTERNAL,
		external: EXTERNAL_NATIVE,
	},
	// Worker units (each is a separate Worker entry point)
	{
		entry: ["src/units/reconUnit.ts"],
		format: "cjs",
		outDir: "../desktop/dist-daemon",
		splitting: false,
		clean: false,
		shims: true,
		noExternal: SHARED_NO_EXTERNAL,
		external: EXTERNAL_NATIVE,
	},
	// COMBAT unit (per-task execution)
	{
		entry: ["src/units/combatUnit.ts"],
		format: "cjs",
		outDir: "../desktop/dist-daemon",
		splitting: false,
		clean: false,
		shims: true,
		noExternal: SHARED_NO_EXTERNAL,
		external: EXTERNAL_NATIVE,
	},
	// INTEL unit (SQLite persistence + FTS5 indexing)
	{
		entry: ["src/units/intelUnit.ts"],
		format: "cjs",
		outDir: "../desktop/dist-daemon",
		splitting: false,
		clean: false,
		shims: true,
		noExternal: SHARED_NO_EXTERNAL,
		external: EXTERNAL_NATIVE,
	},
]);
