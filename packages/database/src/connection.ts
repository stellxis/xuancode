import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export interface ConnectionConfig {
	/** 数据库文件路径 */
	dbPath: string;
	/** 缓存大小（KB），默认 32000 (32MB) */
	cacheSize?: number;
	/** 同步模式，默认 NORMAL */
	synchronous?: "OFF" | "NORMAL" | "FULL" | "EXTRA";
	/** 是否启用外键约束，默认 true */
	foreignKeys?: boolean;
}

const DEFAULT_CONFIG: Partial<ConnectionConfig> = {
	cacheSize: 32000,
	synchronous: "NORMAL",
	foreignKeys: true,
};

/** 创建并配置数据库连接 */
export function createConnection(config: ConnectionConfig): DatabaseType {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const db = new Database(cfg.dbPath);

	// WAL 模式：读写并发不阻塞
	db.pragma("journal_mode = WAL");

	// 外键约束
	if (cfg.foreignKeys) {
		db.pragma("foreign_keys = ON");
	}

	// 缓存大小
	db.pragma(`cache_size = -${cfg.cacheSize}`);

	// 同步模式：平衡性能与安全
	db.pragma(`synchronous = ${cfg.synchronous}`);

	// 临时文件放内存
	db.pragma("temp_store = MEMORY");

	// 减少 WAL 文件大小
	db.pragma("wal_autocheckpoint = 1000");

	return db;
}

/** 数据库连接池（单例） */
// biome-ignore lint/complexity/noStaticOnlyClass: 静态服务注册模式的单例池，语义清晰无需对象化
export class DatabasePool {
	private static instance: DatabaseType | null = null;
	private static refCount = 0;
	private static config: ConnectionConfig | null = null;

	static getInstance(config?: ConnectionConfig): DatabaseType {
		if (!DatabasePool.instance) {
			if (!config)
				throw new Error("DatabasePool: config required for first connection");
			DatabasePool.config = config;
			DatabasePool.instance = createConnection(config);
		}
		DatabasePool.refCount++;
		return DatabasePool.instance;
	}

	static close(): void {
		DatabasePool.refCount--;
		if (DatabasePool.refCount <= 0) {
			DatabasePool.instance?.close();
			DatabasePool.instance = null;
			DatabasePool.config = null;
		}
	}

	static reset(): void {
		DatabasePool.instance?.close();
		DatabasePool.instance = null;
		DatabasePool.refCount = 0;
		DatabasePool.config = null;
	}
}
