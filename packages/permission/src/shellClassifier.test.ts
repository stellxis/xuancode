import { describe, expect, it } from "vitest";
import {
	CommandRisk,
	classifyCommand,
	isDangerousCommand,
} from "./shellClassifier";

describe("shellClassifier", () => {
	it("should classify safe commands", () => {
		const result = classifyCommand("ls -la");
		expect(result.suggestedAction).toBe("allow");
		expect(result.score).toBeLessThan(10);
	});

	it("should classify info commands as safe", () => {
		const result = classifyCommand("cat package.json");
		expect(result.score).toBeLessThan(15);
	});

	it("should flag copy operations", () => {
		const result = classifyCommand("cp source.txt dest.txt");
		expect(result.score).toBeGreaterThan(0);
	});

	it("should block destructive commands", () => {
		const result = classifyCommand("rm -rf /");
		expect(result.suggestedAction).toBe("block");
		expect(result.score).toBeGreaterThanOrEqual(40);
	});

	it("should detect dangerous command patterns", () => {
		expect(isDangerousCommand("rm -rf /")).toBe(true);
		expect(isDangerousCommand("rm -rf /home")).toBe(true);
		expect(isDangerousCommand("ls -la")).toBe(false);
	});

	it("should block git history destruction", () => {
		expect(isDangerousCommand("git push --force origin main")).toBe(true);
		expect(isDangerousCommand("git push -f origin main")).toBe(true);
		expect(isDangerousCommand("git reset --hard HEAD~3")).toBe(true);
		expect(isDangerousCommand("git clean -fd")).toBe(true);
		// normal git ops should pass
		expect(isDangerousCommand("git commit -m 'fix'")).toBe(false);
		expect(isDangerousCommand("git pull")).toBe(false);
	});

	it("should block rm -rf wildcards and current dir", () => {
		expect(isDangerousCommand("rm -rf *")).toBe(true);
		expect(isDangerousCommand("rm -rf .")).toBe(true);
		expect(isDangerousCommand("rm -rf ./")).toBe(true);
		// targeted rm of a specific folder should not be auto-blocked (classifier handles it)
		expect(isDangerousCommand("rm -rf node_modules")).toBe(false);
	});

	it("should block disk wipe and device redirects", () => {
		expect(isDangerousCommand("dd if=/dev/zero of=/dev/sda")).toBe(true);
		expect(isDangerousCommand("mkfs.ext4 /dev/sda1")).toBe(true);
		expect(isDangerousCommand("echo x > /dev/sda")).toBe(true);
	});

	it("should block recursive chmod to 777 on root", () => {
		expect(isDangerousCommand("chmod -R 777 /")).toBe(true);
		expect(isDangerousCommand("chmod 644 file.txt")).toBe(false);
	});

	it("should block fork bombs", () => {
		expect(isDangerousCommand(":(){ :|:& };:")).toBe(true);
	});

	it("should handle sudo escalation", () => {
		const result = classifyCommand("sudo rm -rf /var/log");
		expect(result.score).toBeGreaterThanOrEqual(25);
	});

	it("should classify network commands", () => {
		const result = classifyCommand("curl https://example.com");
		expect(result.reasons.some((r) => r.includes("网络"))).toBe(true);
	});

	it("should assign correct risk levels", () => {
		expect(classifyCommand("ls").risk).toBe(CommandRisk.SAFE);
		expect(classifyCommand("rm -rf /").risk).toBe(CommandRisk.CRITICAL);
	});
});
