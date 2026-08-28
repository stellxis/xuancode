/**
 * Git 工具集 — 代码版本控制操作
 *
 * 提供 6 个核心 Git 工具，覆盖日常开发工作流：
 * git_status, git_diff, git_log, git_branch, git_commit, git_push
 */
import { execFileSync } from "node:child_process";
import type { ToolResult } from "@xuancode/types";

/** Run git command using execFileSync to avoid shell quoting issues on Windows */
function runGit(
	args: string[],
	cwd: string,
): { stdout: string; stderr: string } {
	try {
		const stdout = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			timeout: 30000,
			windowsHide: true,
		});
		return { stdout: stdout.trim(), stderr: "" };
	} catch (err: any) {
		const stderr = (err.stderr || "").toString().trim();
		const stdout = (err.stdout || "").toString().trim();
		return { stdout, stderr };
	}
}

/** 检查是否在 git 仓库中 */
function checkGitRepo(cwd: string): string | null {
	try {
		execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		});
		return null;
	} catch {
		return "当前目录不是 Git 仓库";
	}
}

/**
 * git_status — 查看仓库状态
 */
export async function gitStatus(
	workDir: string,
	options?: { short?: boolean },
): Promise<ToolResult> {
	const startTime = performance.now();
	const repoErr = checkGitRepo(workDir);
	if (repoErr)
		return {
			success: false,
			data: "",
			error: repoErr,
			duration: performance.now() - startTime,
		};

	const short = runGit(["status", options?.short ? "--short" : ""], workDir);
	const branch = runGit(["branch", "--show-current"], workDir);
	const ahead = runGit(
		["rev-list", "--count", "@{upstream}..HEAD", "--"],
		workDir,
	);

	const lines: string[] = [`分支: ${branch.stdout || "(无分支)"}`];

	if (ahead.stdout && ahead.stdout !== "0") {
		lines.push(`领先上游: ${ahead.stdout} 个提交`);
	}

	// 解析 git status --short 为结构化格式
	const raw = short.stdout || runGit(["status", "--short"], workDir).stdout;
	if (raw) {
		const entries = raw.split("\n").filter(Boolean);
		const modified = entries.filter(
			(e) => e.startsWith(" M") || e.startsWith("M "),
		);
		const added = entries.filter(
			(e) => e.startsWith("A ") || e.startsWith("??"),
		);
		const deleted = entries.filter(
			(e) => e.startsWith(" D") || e.startsWith("D "),
		);
		const renamed = entries.filter(
			(e) => e.startsWith(" R") || e.startsWith("R "),
		);

		if (added.length > 0)
			lines.push(
				`\n新增: ${added.length}`,
				...added.map((e) => `  + ${e.slice(2).trim()}`),
			);
		if (modified.length > 0)
			lines.push(
				`\n修改: ${modified.length}`,
				...modified.map((e) => `  ~ ${e.slice(2).trim()}`),
			);
		if (deleted.length > 0)
			lines.push(
				`\n删除: ${deleted.length}`,
				...deleted.map((e) => `  - ${e.slice(2).trim()}`),
			);
		if (renamed.length > 0)
			lines.push(
				`\n重命名: ${renamed.length}`,
				...renamed.map((e) => `  → ${e.slice(2).trim()}`),
			);

		if (entries.length === 0) lines.push("\n工作区干净，无未提交更改");
	}

	return {
		success: true,
		data: lines.join("\n"),
		duration: performance.now() - startTime,
	};
}

/**
 * git_diff — 查看文件差异
 */
export async function gitDiff(
	workDir: string,
	options?: { path?: string; staged?: boolean; context?: number },
): Promise<ToolResult> {
	const startTime = performance.now();
	const repoErr = checkGitRepo(workDir);
	if (repoErr)
		return {
			success: false,
			data: "",
			error: repoErr,
			duration: performance.now() - startTime,
		};

	const args = ["diff"];
	if (options?.staged) args.push("--staged");
	if (options?.context) args.push(`-U${options.context}`);
	if (options?.path) args.push("--", options.path);

	const result = runGit(args, workDir);

	if (!result.stdout) {
		return {
			success: true,
			data: "无差异",
			duration: performance.now() - startTime,
		};
	}

	// 截断过长的 diff
	const maxLen = 8000;
	const output =
		result.stdout.length > maxLen
			? `${result.stdout.slice(0, maxLen)}\n\n... (已截断, 共 ${result.stdout.length} 字符)`
			: result.stdout;

	return {
		success: true,
		data: output,
		duration: performance.now() - startTime,
	};
}

/**
 * git_log — 查看提交历史
 */
export async function gitLog(
	workDir: string,
	options?: { count?: number; branch?: string; format?: string },
): Promise<ToolResult> {
	const startTime = performance.now();
	const repoErr = checkGitRepo(workDir);
	if (repoErr)
		return {
			success: false,
			data: "",
			error: repoErr,
			duration: performance.now() - startTime,
		};

	const count = options?.count || 20;
	const format = options?.format || "%h %s (%ar)";

	const args = [
		"log",
		`--max-count=${count}`,
		`--pretty=format:${format}`,
		options?.branch || "",
	].filter(Boolean);

	const result = runGit(args, workDir);

	if (!result.stdout) {
		return {
			success: true,
			data: "无提交历史",
			duration: performance.now() - startTime,
		};
	}

	// 也获取最新提交的详细信息
	const lastCommit = runGit(
		["log", "-1", "--format=%H%n%an%n%ai%n%s"],
		workDir,
	);

	const lines = [
		`最近 ${count} 个提交 (分支: ${options?.branch || "当前"}):`,
		"",
		result.stdout,
	];

	if (lastCommit.stdout) {
		const [hash, author, date, subject] = lastCommit.stdout.split("\n");
		lines.push(
			"",
			`最新提交: ${hash?.slice(0, 12)}`,
			`  作者: ${author}`,
			`  日期: ${date}`,
			`  说明: ${subject}`,
		);
	}

	return {
		success: true,
		data: lines.join("\n"),
		duration: performance.now() - startTime,
	};
}

/**
 * git_branch — 管理分支
 */
export async function gitBranch(
	workDir: string,
	options?: { action?: "list" | "create" | "delete"; name?: string },
): Promise<ToolResult> {
	const startTime = performance.now();
	const repoErr = checkGitRepo(workDir);
	if (repoErr)
		return {
			success: false,
			data: "",
			error: repoErr,
			duration: performance.now() - startTime,
		};

	const action = options?.action || "list";

	switch (action) {
		case "list": {
			const result = runGit(["branch", "-a"], workDir);
			const current = runGit(["branch", "--show-current"], workDir);
			return {
				success: true,
				data: `当前分支: ${current.stdout || "(无分支)"}\n\n${result.stdout || "(无分支)"}`,
				duration: performance.now() - startTime,
			};
		}
		case "create": {
			if (!options?.name)
				return {
					success: false,
					data: "",
					error: "请指定新分支名称",
					duration: performance.now() - startTime,
				};
			const result = runGit(["checkout", "-b", options.name], workDir);
			if (result.stderr?.includes("fatal:")) {
				return {
					success: false,
					data: "",
					error: result.stderr,
					duration: performance.now() - startTime,
				};
			}
			return {
				success: true,
				data: `已创建并切换到分支: ${options.name}`,
				duration: performance.now() - startTime,
			};
		}
		case "delete": {
			if (!options?.name)
				return {
					success: false,
					data: "",
					error: "请指定要删除的分支名称",
					duration: performance.now() - startTime,
				};
			const result = runGit(["branch", "-D", options.name], workDir);
			if (result.stderr?.includes("error:")) {
				return {
					success: false,
					data: "",
					error: result.stderr,
					duration: performance.now() - startTime,
				};
			}
			return {
				success: true,
				data: `已删除分支: ${options.name}`,
				duration: performance.now() - startTime,
			};
		}
		default:
			return {
				success: false,
				data: "",
				error: `未知操作: ${action}`,
				duration: performance.now() - startTime,
			};
	}
}

/**
 * git_commit — 创建提交
 */
export async function gitCommit(
	workDir: string,
	message: string,
	options?: { addAll?: boolean; allowEmpty?: boolean },
): Promise<ToolResult> {
	const startTime = performance.now();
	const repoErr = checkGitRepo(workDir);
	if (repoErr)
		return {
			success: false,
			data: "",
			error: repoErr,
			duration: performance.now() - startTime,
		};

	if (!message || message.trim().length === 0) {
		return {
			success: false,
			data: "",
			error: "提交信息不能为空",
			duration: performance.now() - startTime,
		};
	}

	// 可选：自动暂存所有更改
	if (options?.addAll) {
		const addResult = runGit(["add", "-A"], workDir);
		if (addResult.stderr?.includes("fatal:")) {
			return {
				success: false,
				data: "",
				error: `暂存失败: ${addResult.stderr}`,
				duration: performance.now() - startTime,
			};
		}
	}

	const args = ["commit", "-m", message];
	if (options?.allowEmpty) args.push("--allow-empty");

	const result = runGit(args, workDir);

	if (result.stderr?.includes("fatal:")) {
		return {
			success: false,
			data: "",
			error: result.stderr,
			duration: performance.now() - startTime,
		};
	}

	// 获取 commit hash
	const hash = runGit(["rev-parse", "HEAD"], workDir);

	return {
		success: true,
		data: result.stdout || "提交成功",
		duration: performance.now() - startTime,
	};
}

/**
 * git_push — 推送到远程
 */
export async function gitPush(
	workDir: string,
	options?: { remote?: string; branch?: string; force?: boolean },
): Promise<ToolResult> {
	const startTime = performance.now();
	const repoErr = checkGitRepo(workDir);
	if (repoErr)
		return {
			success: false,
			data: "",
			error: repoErr,
			duration: performance.now() - startTime,
		};

	const remote = options?.remote || "origin";
	const branch =
		options?.branch || runGit(["branch", "--show-current"], workDir).stdout;

	if (!branch) {
		return {
			success: false,
			data: "",
			error: "无法确定要推送的分支",
			duration: performance.now() - startTime,
		};
	}

	const args = ["push", remote, branch];
	if (options?.force) args.push("--force");

	const result = runGit(args, workDir);
	if (result.stderr) {
		return {
			success: false,
			data: "",
			error: `推送失败: ${result.stderr}`,
			duration: performance.now() - startTime,
		};
	}
	return {
		success: true,
		data: result.stdout,
		duration: performance.now() - startTime,
	};
}
