import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["packages/*/src/**", "apps/*/src/**"],
		},
	},
	resolve: {
		alias: {
			"@xuancode/types": "/packages/types/src",
			"@xuancode/utils": "/packages/utils/src",
			"@xuancode/tools": "/packages/tools/src",
			"@xuancode/context": "/packages/context/src",
			"@xuancode/telemetry": "/packages/telemetry/src",
			"@xuancode/model-adapter": "/packages/model-adapter/src",
			"@xuancode/permission": "/packages/permission/src",
			"@xuancode/orchestrator": "/packages/orchestrator/src",
			"@xuancode/code-intelligence": "/packages/code-intelligence/src",
			"@xuancode/daemon-protocol": "/packages/daemon-protocol/src",
			"@xuancode/database": "/packages/database/src",
			"@xuancode/distiller": "/packages/distiller/src",
			"@xuancode/session": "/packages/session/src",
			"@xuancode/subagent": "/packages/subagent/src",
			"@xuancode/a2a": "/packages/a2a/src",
			"@xuancode/indexer": "/packages/indexer/src",
			"@xuancode/mcp-server": "/packages/mcp-server/src",
			"@xuancode/model-router": "/packages/model-router/src",
			"@xuancode/optimizer": "/packages/optimizer/src",
			"@xuancode/plugins": "/packages/plugins/src",
			"@xuancode/plugin-serpapi": "/packages/plugin-serpapi/src",
			"@xuancode/plugin-duckduckgo": "/packages/plugin-duckduckgo/src",
			"@xuancode/plugin-searxng": "/packages/plugin-searxng/src",
		},
	},
});
