import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resolveHome,
	resolveManagedPolicy,
	resolveMemoryScopeDir,
	resolveProjectData,
	resolveServerData,
} from "./paths";

const ENV_KEYS = [
	"XUANCODE_HOME",
	"XUANCODE_PROJECT_DATA",
	"XUANCODE_SERVER_DATA",
	"XUANCODE_MANAGED_POLICY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		Reflect.deleteProperty(process.env, key);
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = saved[key];
	}
});

describe("resolveHome", () => {
	it("XUANCODE_HOME 优先", () => {
		process.env.XUANCODE_HOME = "/tmp/fake-home";
		expect(resolveHome()).toBe("/tmp/fake-home");
	});

	it("无 env 时用 HOME/USERPROFILE", () => {
		process.env.HOME = "/tmp/home-env";
		Reflect.deleteProperty(process.env, "USERPROFILE");
		expect(resolveHome()).toBe("/tmp/home-env");
	});

	it("兜底 os.homedir()", () => {
		Reflect.deleteProperty(process.env, "HOME");
		Reflect.deleteProperty(process.env, "USERPROFILE");
		expect(resolveHome()).toBe(os.homedir());
	});
});

describe("resolveProjectData", () => {
	it("部署语义：默认原地 <workDir>/.xuancode", () => {
		expect(resolveProjectData("/repo")).toBe(path.join("/repo", ".xuancode"));
	});

	it("开发语义：XUANCODE_PROJECT_DATA 覆盖到仓库外", () => {
		process.env.XUANCODE_PROJECT_DATA = "/tmp/dev-data";
		expect(resolveProjectData("/repo")).toBe("/tmp/dev-data");
	});
});

describe("resolveServerData", () => {
	it("本地模式默认 ~/.xuancode/server", () => {
		process.env.XUANCODE_HOME = "/tmp/fake-home";
		expect(resolveServerData()).toBe(
			path.join("/tmp/fake-home", ".xuancode", "server"),
		);
	});

	it("XUANCODE_SERVER_DATA 可覆盖（云端实例内路径）", () => {
		process.env.XUANCODE_SERVER_DATA = "/var/lib/xuancode";
		expect(resolveServerData()).toBe("/var/lib/xuancode");
	});
});

describe("resolveManagedPolicy", () => {
	it("默认 /etc/xuancode/xuancode.md", () => {
		expect(resolveManagedPolicy()).toBe(
			path.join("/etc", "xuancode", "xuancode.md"),
		);
	});

	it("XUANCODE_MANAGED_POLICY 注入", () => {
		process.env.XUANCODE_MANAGED_POLICY = "C:/deploy/policy.md";
		expect(resolveManagedPolicy()).toBe("C:/deploy/policy.md");
	});
});

describe("resolveMemoryScopeDir", () => {
	it("无 projectDir → global/", () => {
		process.env.XUANCODE_HOME = "/tmp/fake-home";
		expect(resolveMemoryScopeDir()).toBe(
			path.join("/tmp/fake-home", ".xuancode", "memory", "global"),
		);
	});

	it("有 projectDir → projects/<slug>/", () => {
		process.env.XUANCODE_HOME = "/tmp/fake-home";
		const dir = resolveMemoryScopeDir("/repo");
		expect(
			dir.startsWith(
				path.join("/tmp/fake-home", ".xuancode", "memory", "projects"),
			),
		).toBe(true);
		expect(path.basename(dir)).toMatch(/^[a-z0-9_-]{1,80}$/);
	});
});
