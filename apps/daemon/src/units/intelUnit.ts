import { SessionPersistence } from "@xuancode/database";
import { SessionIndexer } from "@xuancode/indexer";
import { UnitBase } from "./UnitBase.js";

interface IntelInitParams {
	dbPath: string;
}

interface SaveSessionParams {
	sessionId: string;
	entries: any[];
	indexAfterSave: boolean;
}

interface SearchSessionsParams {
	query: string;
	limit: number;
}

// ===== INTEL 情报单元 =====

class IntelUnit extends UnitBase {
	protected readonly unitName = "INTEL";
	private persistence: SessionPersistence | null = null;
	private indexer: SessionIndexer | null = null;

	constructor() {
		super();

		// ---- Init (async: create dir, run migrations) ----
		this.onRequest("init", async (params: unknown) => {
			const { dbPath } = params as IntelInitParams;
			this.persistence = new SessionPersistence(dbPath);
			await this.persistence.initialize();
			const db = this.persistence.getDb();
			this.indexer = new SessionIndexer(db);
			this.indexer.ensureFTS();
			return { success: true };
		});

		// ---- Save session (bundles save + optional index) ----
		this.onRequest("save_session", async (params: unknown) => {
			const { sessionId, entries, indexAfterSave } =
				params as SaveSessionParams;
			this.persistence?.saveSession(sessionId, entries);
			if (indexAfterSave) {
				this.indexer?.indexSession(sessionId);
			}
			return { success: true };
		});

		// ---- Rebuild session (delete + re-import) ----
		this.onRequest("rebuild_session", async (params: unknown) => {
			const { sessionId, entries } = params as any;
			this.persistence?.rebuildSession(sessionId, entries);
			this.indexer?.indexSession(sessionId);
			return { success: true };
		});

		// ---- List sessions ----
		this.onRequest("list_sessions", async (params: unknown) => {
			const { limit, offset } = (params || {}) as any;
			return this.persistence?.listSessions(limit ?? 50, offset ?? 0);
		});

		// ---- Get session detail ----
		this.onRequest("get_session_detail", async (params: unknown) => {
			const { sessionId } = params as any;
			return this.persistence?.getSessionDetail(sessionId);
		});

		// ---- Delete session (with FTS5 cleanup) ----
		this.onRequest("delete_session", async (params: unknown) => {
			const { sessionId } = params as any;
			this.persistence?.deleteSession(sessionId);
			this.indexer?.removeSession(sessionId);
			return { success: true };
		});

		// ---- Get stats ----
		this.onRequest("get_stats", async () => {
			return this.persistence?.getStats();
		});

		// ---- Search sessions (FTS5) ----
		this.onRequest("search_sessions", async (params: unknown) => {
			const { query, limit } = (params || {}) as SearchSessionsParams;
			if (!this.indexer) return { results: [] };
			const results = this.indexer.search(query, limit ?? 20);
			return { results };
		});

		// ---- Rebuild all FTS5 index ----
		this.onRequest("rebuild_index", async () => {
			this.indexer?.rebuildAll();
			return { success: true };
		});

		// ---- Close database connection ----
		this.onRequest("close", async () => {
			this.persistence?.close();
			this.persistence = null;
			this.indexer = null;
			return { success: true };
		});

		// ---- Get status ----
		this.onRequest("get_status", async () => {
			return {
				initialized: this.persistence !== null,
				uptime: Date.now() - this.startedAt,
			};
		});

		this.startHeartbeat();
		console.error("[INTEL] Unit initialized");
	}
}

new IntelUnit();
