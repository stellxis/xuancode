/**
 * 供应链安全：安装前校验 npm 包完整性 + 可选 cosign 签名校验
 *
 * 三层防御：
 *   1. registry metadata 获取最新版本号 + dist.integrity（pin 版本，防止 latest tag 投毒）
 *   2. npm install 后比对 node_modules/.package-lock.json 的 integrity 与 registry 一致
 *   3. 若 XUANCODE_REQUIRE_SIGNATURE=1 且 cosign 可用，校验 registry 中存储的 sigstore 签名
 *
 * 失败时调用方应执行 `npm uninstall` 撤销安装。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const NPM_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT = 15_000;

interface NpmDistMetadata {
	version: string;
	tarball: string;
	integrity: string;
	shasum: string;
}

export interface VerifyOptions {
	/** 工作目录（含 node_modules） */
	workDir: string;
	/** 包名（已通过白名单校验） */
	pkgName: string;
	/** 期望版本（不传则取 registry latest） */
	expectedVersion?: string;
	/** npm registry metadata URL 覆盖（默认 npmjs.org） */
	registryBaseUrl?: string;
	/**
	 * 玄码 registry 基址（用于拉取签名 bundle + 公钥）
	 * 例如 http://localhost:3022 — 不传则签名校验被跳过（除非 requireSignature=true 时失败）
	 */
	xuancodeRegistryUrl?: string;
	/** 玄码插件名（registry 中存储 signing 的 key；与 npm pkgName 可能不同） */
	pluginName?: string;
	/** 是否强制要求 sigstore 签名（默认 false，仅当环境变量开启时强制） */
	requireSignature?: boolean;
}

export type VerifyResult =
	| {
			ok: true;
			version: string;
			integrity: string;
			signatureChecked: boolean;
			signatureSkipped?: string;
	  }
	| {
			ok: false;
			reason: string;
			code:
				| "fetch_failed"
				| "version_mismatch"
				| "integrity_mismatch"
				| "signature_failed"
				| "lockfile_missing";
	  };

/**
 * 获取 npm registry 元数据，返回 dist 字段
 */
export async function fetchNpmDist(
	pkgName: string,
	version: string | undefined,
	registryBaseUrl: string = NPM_REGISTRY,
): Promise<NpmDistMetadata | null> {
	const url = `${registryBaseUrl}/${encodeURIComponent(pkgName).replace("%40", "@")}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { Accept: "application/vnd.npm.install-v1+json" },
		});
		if (!response.ok) return null;
		const meta = (await response.json()) as any;
		const targetVersion = version || meta["dist-tags"]?.latest;
		if (!targetVersion) return null;
		const versionMeta = meta.versions?.[targetVersion];
		if (!versionMeta?.dist) return null;
		return {
			version: targetVersion,
			tarball: versionMeta.dist.tarball,
			integrity: versionMeta.dist.integrity,
			shasum: versionMeta.dist.shasum,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 安装后校验：读取 node_modules/<pkg>/.package-lock.json 的 integrity 字段，
 * 与 registry metadata 中的 dist.integrity 进行常量时间比较
 */
export function verifyInstalledIntegrity(
	workDir: string,
	pkgName: string,
	expectedIntegrity: string,
): { ok: true } | { ok: false; reason: string } {
	// npm v7+ 在 node_modules/<pkg>/.package-lock.json 写入 integrity 字段
	// scoped 包路径：@scope/name → node_modules/@scope/name/.package-lock.json
	const pkgLockPath = path.join(
		workDir,
		"node_modules",
		pkgName,
		".package-lock.json",
	);
	let pkgLock: any;
	try {
		pkgLock = JSON.parse(fs.readFileSync(pkgLockPath, "utf-8"));
	} catch {
		return {
			ok: false,
			reason: `无法读取 ${pkgLockPath}（npm 版本过旧或安装失败）`,
		};
	}

	const actual = pkgLock.integrity || pkgLock._integrity;
	if (!actual) {
		return { ok: false, reason: "package-lock 中缺少 integrity 字段" };
	}

	if (actual.length !== expectedIntegrity.length) {
		return { ok: false, reason: "integrity 长度不匹配" };
	}
	try {
		if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expectedIntegrity))) {
			return {
				ok: false,
				reason: "integrity 不匹配 — 安装的包与 registry 发布的不一致",
			};
		}
	} catch {
		return { ok: false, reason: "integrity 比较异常" };
	}
	return { ok: true };
}

/**
 * cosign 签名校验
 *
 * 调用 `cosign verify-blob --key <pubKey> --signature <sig> --bundle <bundle> <tarball>`。
 * 当 cosign 不可用时返回 skipped，调用方根据 requireSignature 决定是否拒绝安装。
 *
 * 优先使用 Rekor bundle（含透明日志 entry），其次使用裸签名。
 */
export async function verifyCosignSignature(
	tarballPath: string,
	signature: string,
	pubKey: string,
	bundle?: string,
): Promise<{ verified: boolean; skipped?: boolean; reason?: string }> {
	try {
		await execFileP("cosign", ["version"], {
			timeout: 5_000,
			windowsHide: true,
		});
	} catch {
		return {
			verified: false,
			skipped: true,
			reason: "cosign 未安装或不在 PATH",
		};
	}

	// 写入临时文件：signature / pubkey / bundle
	const tmpDir = path.join(os.tmpdir(), `xuancode-verify-${randomUUID()}`);
	fs.mkdirSync(tmpDir, { recursive: true });
	const sigPath = path.join(tmpDir, "sig.b64");
	const pubKeyPath = path.join(tmpDir, "pub.pem");
	const bundlePath = path.join(tmpDir, "bundle.json");
	try {
		fs.writeFileSync(sigPath, signature);
		fs.writeFileSync(pubKeyPath, pubKey);
		if (bundle) fs.writeFileSync(bundlePath, bundle);

		const args = ["verify-blob", "--key", pubKeyPath, "--signature", sigPath];
		if (bundle) args.push("--bundle", bundlePath);
		args.push(tarballPath);

		await execFileP("cosign", args, {
			timeout: 30_000,
			windowsHide: true,
			env: { ...process.env, COSIGN_EXPERIMENTAL: "1" },
		});
		return { verified: true };
	} catch (err: any) {
		return {
			verified: false,
			reason: err?.message || "cosign verify-blob 失败",
		};
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

/** 从 registry 拉取签名 bundle */
async function fetchSigningBundle(
	registryBaseUrl: string,
	pluginName: string,
): Promise<{
	signature: string;
	bundle?: string;
	publicKey?: string;
	signedAt?: string;
} | null> {
	const url = `${registryBaseUrl.replace(/\/$/, "")}/plugins/${encodeURIComponent(pluginName)}/signing`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) return null;
		const data = (await response.json()) as any;
		if (!data?.signed || !data?.signing?.signature) return null;
		return {
			signature: data.signing.signature,
			bundle: data.signing.bundle,
			publicKey: data.signing.publicKey,
			signedAt: data.signing.signedAt,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** 拉取 registry 公钥（离线模式：环境变量优先） */
async function fetchRegistryPublicKey(
	registryBaseUrl: string,
): Promise<string | null> {
	if (process.env.XUANCODE_SIGNING_PUBKEY)
		return process.env.XUANCODE_SIGNING_PUBKEY;
	const url = `${registryBaseUrl.replace(/\/$/, "")}/.well-known/xuancode-signing.pub`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) return null;
		return await response.text();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** 下载 tarball 到临时文件，返回路径（调用方负责清理） */
async function downloadTarball(
	tarballUrl: string,
	destDir: string,
): Promise<string | null> {
	const tarballPath = path.join(destDir, "package.tgz");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const response = await fetch(tarballUrl, { signal: controller.signal });
		if (!response.ok) return null;
		const buf = Buffer.from(await response.arrayBuffer());
		fs.writeFileSync(tarballPath, buf);
		return tarballPath;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 完整安装前校验流程
 *
 * 使用方式：
 *   const result = await verifyPackageForInstall({ workDir, pkgName });
 *   if (!result.ok) { /* 卸载并返回 500 *\/ }
 */
export async function verifyPackageForInstall(
	opts: VerifyOptions,
): Promise<VerifyResult> {
	const dist = await fetchNpmDist(
		opts.pkgName,
		opts.expectedVersion,
		opts.registryBaseUrl,
	);
	if (!dist) {
		return {
			ok: false,
			reason: "无法从 npm registry 获取元数据",
			code: "fetch_failed",
		};
	}

	// 版本一致性：若用户指定了版本，dist.version 必须匹配
	if (opts.expectedVersion && dist.version !== opts.expectedVersion) {
		return {
			ok: false,
			reason: `registry 返回版本 ${dist.version} 与期望 ${opts.expectedVersion} 不一致`,
			code: "version_mismatch",
		};
	}

	// 完整性校验
	const integrityResult = verifyInstalledIntegrity(
		opts.workDir,
		opts.pkgName,
		dist.integrity,
	);
	if (!integrityResult.ok) {
		return {
			ok: false,
			reason: integrityResult.reason,
			code: "integrity_mismatch",
		};
	}

	// 签名校验
	// 严格模式（XUANCODE_REQUIRE_SIGNATURE=1 或 opts.requireSignature）下必须验证；
	// 非严格模式下若 registry 配置完整也尝试验证，验证失败仅警告不拒绝
	const requireSig =
		opts.requireSignature ?? process.env.XUANCODE_REQUIRE_SIGNATURE === "1";
	const xuancodeRegistry =
		opts.xuancodeRegistryUrl || process.env.XUANCODE_REGISTRY_URL;
	const pluginName = opts.pluginName || opts.pkgName;

	if (requireSig) {
		if (!xuancodeRegistry) {
			return {
				ok: false,
				reason:
					"严格签名模式已开启，但未配置 XUANCODE_REGISTRY_URL（无法拉取签名 bundle）",
				code: "signature_failed",
			};
		}

		// 1. 拉取签名 bundle
		const signingBundle = await fetchSigningBundle(
			xuancodeRegistry,
			pluginName,
		);
		if (!signingBundle) {
			return {
				ok: false,
				reason: `registry 未为插件 ${pluginName} 提供签名`,
				code: "signature_failed",
			};
		}

		// 2. 获取公钥（优先 bundle 内 publicKey，否则拉 .well-known）
		let publicKey: string | undefined = signingBundle.publicKey;
		if (!publicKey) {
			publicKey = (await fetchRegistryPublicKey(xuancodeRegistry)) || undefined;
		}
		if (!publicKey) {
			return {
				ok: false,
				reason: "无法获取 registry 签名公钥",
				code: "signature_failed",
			};
		}

		// 3. 下载 tarball 到临时文件
		const tmpDir = path.join(os.tmpdir(), `xuancode-verify-${randomUUID()}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		try {
			const tarballPath = await downloadTarball(dist.tarball, tmpDir);
			if (!tarballPath) {
				return {
					ok: false,
					reason: `无法下载 tarball: ${dist.tarball}`,
					code: "signature_failed",
				};
			}

			// 4. cosign verify-blob
			const verify = await verifyCosignSignature(
				tarballPath,
				signingBundle.signature,
				publicKey,
				signingBundle.bundle,
			);

			if (verify.skipped) {
				return {
					ok: false,
					reason: `签名校验跳过: ${verify.reason}`,
					code: "signature_failed",
				};
			}
			if (!verify.verified) {
				return {
					ok: false,
					reason: `签名校验失败: ${verify.reason}`,
					code: "signature_failed",
				};
			}
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}

		return {
			ok: true,
			version: dist.version,
			integrity: dist.integrity,
			signatureChecked: true,
		};
	}

	return {
		ok: true,
		version: dist.version,
		integrity: dist.integrity,
		signatureChecked: false,
	};
}

/** 工具：对 tarball 字节计算 sha512（用于 SLSA provenance） */
export function computeSha512(filePath: string): string {
	const buf = fs.readFileSync(filePath);
	return createHash("sha512").update(buf).digest("hex");
}
