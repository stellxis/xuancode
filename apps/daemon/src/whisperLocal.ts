/**
 * 离线语音识别引擎 — 通过 whisper.cpp CLI 实现一键转写
 *
 * 自动下载 whisper.cpp CLI 二进制和模型，
 * 每次转写时以 one-shot 模式启动子进程，处理完即退出。
 *
 * 支持的音频格式：WAV（需在客户端预先转换）
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const WHISPER_VERSION = "v1.8.4";

const DOWNLOAD_URLS = {
	// whisper.cpp CLI binary (Windows x64) — 包含 whisper-cli.exe
	bin: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`,
	// Tiny 模型 (~75MB)，支持多语言 — 多个镜像地址，依次尝试
	model: [
		"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
		"https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
	],
};

export interface WhisperLocalOptions {
	/** 存放 whisper 二进制和模型的目录 */
	dataDir: string;
}

export interface TranscriptionResult {
	text: string;
	error?: string;
}

export class WhisperLocalEngine {
	private dataDir: string;
	private _ready = false;
	private _error = "";
	private _binaryPath = "";
	private _modelPath = "";

	constructor(opts: WhisperLocalOptions) {
		this.dataDir = opts.dataDir;
		// 如果文件已存在，直接初始化路径
		this.scanExisting();
	}

	private scanExisting(): void {
		const binCandidates = [path.join(this.dataDir, "whisper-cli.exe")];
		for (const p of binCandidates) {
			if (fs.existsSync(p)) {
				this._binaryPath = p;
				break;
			}
		}

		const modelCandidate = path.join(this.dataDir, "ggml-tiny.bin");
		if (fs.existsSync(modelCandidate)) {
			this._modelPath = modelCandidate;
		}

		if (this._binaryPath && this._modelPath) {
			this._ready = true;
		}
	}

	get isReady(): boolean {
		return this._ready;
	}
	get error(): string {
		return this._error;
	}
	get binPath(): string {
		return this._binaryPath;
	}
	get modelPath(): string {
		return this._modelPath;
	}

	/** 二进制和模型是否已就绪 */
	get isDownloaded(): boolean {
		return !!(
			this._binaryPath &&
			this._modelPath &&
			fs.existsSync(this._binaryPath) &&
			fs.existsSync(this._modelPath)
		);
	}

	downloadProgress = { bin: 0, model: 0 };

	// ===== 递归搜索 whisper-cli.exe =====

	private findBinary(dir: string): string | null {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		// 优先查找新名称（whisper-whisper-cli.exe），回退到旧名称
		let fallback: string | null = null;
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (!e.isFile() || !e.name.endsWith(".exe")) {
				if (e.isDirectory()) {
					const found = this.findBinary(full);
					if (found) {
						if (found.includes("whisper-whisper-cli")) return found;
						fallback = found;
					}
				}
				continue;
			}
			if (e.name.includes("whisper-whisper-cli")) return full;
			if (
				e.name.includes("whisper-cli") ||
				e.name === "main.exe" ||
				e.name === "whisper.exe"
			) {
				fallback = full;
			}
		}
		return fallback;
	}

	// ===== 下载引擎 =====

	async download(onProgress?: (msg: string) => void): Promise<void> {
		fs.mkdirSync(this.dataDir, { recursive: true });
		const send = (m: string) => onProgress?.(m);

		// 下载 binary zip
		const zipPath = path.join(this.dataDir, "whisper-bin-x64.zip");
		if (!fs.existsSync(zipPath)) {
			send("正在下载语音识别引擎...");
			await this.downloadFile(DOWNLOAD_URLS.bin, zipPath, (pct) => {
				this.downloadProgress.bin = pct;
				send(`下载引擎 ${pct}%`);
			});
		}

		// 解压 zip
		send("正在解压引擎...");
		await this.extractZip(zipPath, this.dataDir);

		// 解压后文件可能在子目录中（如 whisper-bin-x64/），将所有文件移到 dataDir 根目录
		this.flattenDirectory(this.dataDir);

		// 找到 binary 并重命名为统一名称
		const foundBin = this.findBinary(this.dataDir);
		if (!foundBin) {
			throw new Error("在压缩包中未找到 whisper-cli.exe");
		}
		const targetPath = path.join(this.dataDir, "whisper-cli.exe");
		if (foundBin !== targetPath) {
			if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
			fs.renameSync(foundBin, targetPath);
		}
		this._binaryPath = targetPath;

		// 清理 zip
		try {
			fs.unlinkSync(zipPath);
		} catch {
			/* 忽略 */
		}

		// 下载模型（尝试多个镜像地址）
		this._modelPath = path.join(this.dataDir, "ggml-tiny.bin");
		if (!fs.existsSync(this._modelPath)) {
			send("正在下载语音模型 (ggml-tiny ~75MB)...");
			const modelUrls = DOWNLOAD_URLS.model;
			let modelOk = false;
			for (let mi = 0; mi < modelUrls.length; mi++) {
				try {
					if (mi > 0)
						send(`下载模型，尝试镜像 ${mi + 1}/${modelUrls.length}...`);
					await this.downloadFile(
						modelUrls[mi],
						this._modelPath,
						(pct) => {
							this.downloadProgress.model = pct;
							send(`下载模型 ${pct}%`);
						},
						180_000,
					); // 模型文件较大，用更长的超时
					modelOk = true;
					break;
				} catch (err: any) {
					console.error(
						`[离线引擎] 模型下载失败 (${modelUrls[mi]}): ${err.message}`,
					);
					// 清理失败的文件
					try {
						fs.unlinkSync(this._modelPath);
					} catch {
						/* 忽略 */
					}
					if (mi < modelUrls.length - 1) {
						send(`镜像 ${mi + 1} 不可用，尝试下一个...`);
					}
				}
			}
			if (!modelOk) {
				throw new Error(
					`语音模型下载失败，所有镜像均不可用。\n请检查网络连接，或手动下载模型文件放到:\n${this._modelPath}\n下载地址: ${modelUrls.join("\n         ")}`,
				);
			}
		}

		this._ready = true;
		this._error = "";
		send("离线语音引擎就绪");
	}

	// ===== 一键转写 =====
	//
	// 接收 base64 编码的 WAV 音频数据，保存为临时文件，
	// 启动 whisper-cli 处理，读取输出文本，清理临时文件。

	async transcribe(base64Data: string): Promise<TranscriptionResult> {
		if (!this.isDownloaded) {
			return { text: "", error: "离线引擎未就绪，请先在设置中下载" };
		}

		const tmpFile = path.join(
			os.tmpdir(),
			`whisper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
		);
		try {
			fs.writeFileSync(tmpFile, Buffer.from(base64Data, "base64"));

			const result = await new Promise<TranscriptionResult>((resolve) => {
				const proc = spawn(
					this._binaryPath,
					["-m", this._modelPath, "-f", tmpFile, "--output-txt", "--no-prints"],
					{
						windowsHide: true,
						timeout: 60_000,
					},
				);

				let stdout = "";
				let stderr = "";

				proc.stdout?.on("data", (d: Buffer) => {
					stdout += d.toString();
				});
				proc.stderr?.on("data", (d: Buffer) => {
					stderr += d.toString();
				});

				proc.on("error", (err) => {
					resolve({ text: "", error: `启动 whisper 失败: ${err.message}` });
				});

				proc.on("exit", (code) => {
					// 优先读取 whisper 生成的 .txt 文件
					const outFile = `${tmpFile}.txt`;
					if (fs.existsSync(outFile)) {
						try {
							const text = fs.readFileSync(outFile, "utf-8").trim();
							if (text) {
								resolve({ text });
								return;
							}
						} catch {
							/* 忽略，继续 fallback */
						}
					}

					// fallback: 从 stdout 中解析时间戳文本行
					// whisper 默认输出: [00:00:00.000 --> 00:00:05.000] 文本内容
					if (stdout) {
						const lines = stdout
							.split("\n")
							.map((l) =>
								l
									.replace(
										/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)/,
										"$1",
									)
									.trim(),
							)
							.filter(Boolean);
						if (lines.length > 0) {
							resolve({ text: lines.join(" ") });
							return;
						}
						// 也可能是纯文本输出
						const plain = stdout.trim();
						if (plain) {
							resolve({ text: plain });
							return;
						}
					}

					if (code !== 0) {
						const friendlyMsg = this.formatExitCode(code);
						resolve({
							text: "",
							error: `whisper 进程退出 (code ${code}): ${stderr.slice(0, 300)}${friendlyMsg}`,
						});
					} else {
						resolve({ text: "" });
					}
				});
			});

			return result;
		} catch (err: any) {
			return { text: "", error: `转写异常: ${err.message}` };
		} finally {
			// 清理临时文件
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				/* 忽略 */
			}
			try {
				fs.unlinkSync(`${tmpFile}.txt`);
			} catch {
				/* 忽略 */
			}
		}
	}

	// ===== 下载与解压工具 =====

	/** 格式化进程退出码为友好提示 */
	private formatExitCode(code: number | null): string {
		if (code === null) return "\n进程被信号终止";
		// NTSTATUS 错误码映射
		const map: Record<number, string> = {
			3221225781:
				"\n原因: 系统缺少 VC++ 运行时库，请安装:\nhttps://aka.ms/vs/17/release/vc_redist.x64.exe",
			3221225794: "\n原因: DLL 初始化失败",
			3221225477: "\n原因: 访问冲突 (内存错误)",
			3221225501: "\n原因: 非法指令 — CPU 不支持 AVX",
		};
		const hex = `0x${code.toString(16).toUpperCase().padStart(8, "0")}`;
		const msg = map[code];
		return msg ? `${hex} ${msg}` : hex;
	}

	/** 将 dataDir 下所有子目录中的文件平移到 dataDir 根目录，然后删除空子目录 */
	private flattenDirectory(dir: string): void {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const subDir = path.join(dir, e.name);
			try {
				const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
				for (const sf of subFiles) {
					if (sf.isFile() || sf.isDirectory()) {
						const src = path.join(subDir, sf.name);
						const dst = path.join(dir, sf.name);
						if (!fs.existsSync(dst)) {
							fs.renameSync(src, dst);
						}
					}
				}
				// 删除空子目录
				fs.rmdirSync(subDir);
			} catch {
				/* 忽略无法处理的子目录 */
			}
		}
	}

	private downloadFile(
		url: string,
		dest: string,
		onProgress?: (pct: number) => void,
		timeoutMs = 120_000,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const transport = url.startsWith("https") ? https : http;
			const file = fs.createWriteStream(dest);

			const req = transport.get(url, (res) => {
				if (
					res.statusCode &&
					res.statusCode >= 300 &&
					res.statusCode < 400 &&
					res.headers.location
				) {
					file.close();
					try {
						fs.unlinkSync(dest);
					} catch {
						/* 忽略 */
					}
					this.downloadFile(
						res.headers.location,
						dest,
						onProgress,
						timeoutMs,
					).then(resolve, reject);
					return;
				}
				if (!res.statusCode || res.statusCode >= 400) {
					file.close();
					try {
						fs.unlinkSync(dest);
					} catch {
						/* 忽略 */
					}
					reject(new Error(`下载失败 (HTTP ${res.statusCode})`));
					return;
				}

				const total = Number.parseInt(res.headers["content-length"] || "0", 10);
				let loaded = 0;
				let stalled = true;
				const stallTimer = setTimeout(() => {
					stalled = true;
				}, 15_000);

				res.on("data", (chunk: Buffer) => {
					loaded += chunk.length;
					file.write(chunk);
					if (total > 0) onProgress?.(Math.round((loaded / total) * 100));
					// Reset stall detector
					if (!stalled) {
						clearTimeout(stallTimer);
						setTimeout(() => {
							stalled = true;
						}, 15_000);
					}
					stalled = false;
				});

				res.on("end", () => {
					clearTimeout(stallTimer);
					file.end();
					resolve();
				});

				res.on("error", (err) => {
					clearTimeout(stallTimer);
					file.close();
					try {
						fs.unlinkSync(dest);
					} catch {
						/* 忽略 */
					}
					reject(err);
				});
			});

			req.setTimeout(timeoutMs, () => {
				req.destroy();
				file.close();
				try {
					fs.unlinkSync(dest);
				} catch {
					/* 忽略 */
				}
				reject(
					new Error(
						`下载超时 (${timeoutMs / 1000}s) - 请检查网络连接，GitHub 可能需要代理`,
					),
				);
			});

			req.on("error", (err) => {
				file.close();
				try {
					fs.unlinkSync(dest);
				} catch {
					/* 忽略 */
				}
				reject(err);
			});
		});
	}

	private extractZip(zipPath: string, destDir: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const ps = spawn(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					`Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
				],
				{ windowsHide: true },
			);

			ps.on("exit", (code) => {
				if (code !== 0) reject(new Error(`解压失败 (code: ${code})`));
				else resolve();
			});

			ps.on("error", reject);
		});
	}
}
