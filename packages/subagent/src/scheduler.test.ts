import { describe, expect, it } from "vitest";
import { SUB_AGENT_TYPES, getAgentInstructions } from "./scheduler";

describe("SubAgentScheduler", () => {
	describe("getAgentInstructions", () => {
		it("should return explore agent config", () => {
			const config = getAgentInstructions("explore");
			expect(config.mode).toBe("plan");
			expect(config.tools).toContain("grep");
			expect(config.purpose).toContain("只读");
		});

		it("should return implement agent config", () => {
			const config = getAgentInstructions("implement");
			expect(config.mode).toBe("default");
			expect(config.tools).toContain("write_file");
			expect(config.tools).toContain("shell");
		});

		it("should return security agent config", () => {
			const config = getAgentInstructions("security");
			expect(config.mode).toBe("auto");
			expect(config.purpose).toContain("安全");
		});

		it("should contain all 8 agent types", () => {
			expect(SUB_AGENT_TYPES).toEqual([
				"explore",
				"plan",
				"implement",
				"review",
				"security",
				"test",
				"docs",
				"debug",
			]);
		});
	});
});
