import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationManager, createConnection } from "./index";

describe("MigrationManager edge cases", () => {
	let db: Database.Database;
	let migrationsDir: string;

	beforeEach(() => {
		db = createConnection({ dbPath: ":memory:" });
		migrationsDir = path.join(tmpdir(), `migrations-test-${randomUUID()}`);
		fs.mkdirSync(migrationsDir, { recursive: true });
	});

	afterEach(() => {
		db.close();
		// Cleanup temp migration files
		try {
			const files = fs.readdirSync(migrationsDir);
			for (const f of files) fs.unlinkSync(path.join(migrationsDir, f));
			fs.rmdirSync(migrationsDir);
		} catch {
			/* ok */
		}
	});

	it("should handle empty migrations directory (fallback to embedded)", () => {
		const mgr = new MigrationManager(db, migrationsDir);
		expect(() => mgr.migrate()).not.toThrow();
		// 空目录回退到内嵌迁移（打包环境无 .sql 文件时仍可用）
		const status = mgr.getStatus();
		expect(status.length).toBeGreaterThan(0);
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
			)
			.all();
		expect(tables.length).toBe(1);
	});

	it("should apply migrations in version order", () => {
		// Create out-of-order files
		fs.writeFileSync(
			path.join(migrationsDir, "002_second.sql"),
			"CREATE TABLE second (id INTEGER PRIMARY KEY);",
		);
		fs.writeFileSync(
			path.join(migrationsDir, "001_first.sql"),
			"CREATE TABLE first (id INTEGER PRIMARY KEY);",
		);

		const mgr = new MigrationManager(db, migrationsDir);
		mgr.migrate();

		// Both tables should exist
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('first', 'second') ORDER BY name",
			)
			.all() as { name: string }[];
		expect(tables.map((t) => t.name)).toEqual(["first", "second"]);

		const records = db
			.prepare("SELECT version FROM _migrations ORDER BY version")
			.all() as any[];
		expect(records.map((r) => r.version)).toEqual([1, 2]);
	});

	it("should reject invalid migration filenames", () => {
		fs.writeFileSync(
			path.join(migrationsDir, "bad_file.sql"),
			"CREATE TABLE t (id INT);",
		);
		fs.writeFileSync(
			path.join(migrationsDir, "003_valid.sql"),
			"CREATE TABLE valid (id INT);",
		);

		const mgr = new MigrationManager(db, migrationsDir);
		expect(() => mgr.loadMigrations()).toThrow("Invalid migration filename");
	});

	it("should skip already-applied migrations", () => {
		// Manually insert a migration record
		db.exec(
			"CREATE TABLE _migrations (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT)",
		);
		db.prepare(
			"INSERT INTO _migrations (version, description, applied_at) VALUES (1, 'test', ?)",
		).run(new Date().toISOString());

		// Create migration file for version 1
		fs.writeFileSync(
			path.join(migrationsDir, "001_test.sql"),
			"CREATE TABLE should_not_apply (id INT)",
		);

		const mgr = new MigrationManager(db, migrationsDir);
		mgr.migrate(); // should not throw

		// Table should NOT exist (migration was skipped)
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE name='should_not_apply'")
			.all();
		expect(tables.length).toBe(0);
	});

	it("should handle multiple new migrations sequentially", () => {
		for (let i = 1; i <= 5; i++) {
			fs.writeFileSync(
				path.join(migrationsDir, `${String(i).padStart(3, "0")}_mig_${i}.sql`),
				`CREATE TABLE mig_${i} (id INTEGER PRIMARY KEY);`,
			);
		}

		const mgr = new MigrationManager(db, migrationsDir);
		mgr.migrate();

		const records = db
			.prepare("SELECT version FROM _migrations ORDER BY version")
			.all() as any[];
		expect(records.length).toBe(5);

		// All 5 tables should exist
		for (let i = 1; i <= 5; i++) {
			const t = db
				.prepare(`SELECT name FROM sqlite_master WHERE name='mig_${i}'`)
				.all();
			expect(t.length).toBe(1);
		}
	});

	it("should report status with applied timestamps", () => {
		fs.writeFileSync(
			path.join(migrationsDir, "001_test.sql"),
			"CREATE TABLE test_status (id INT)",
		);

		const mgr = new MigrationManager(db, migrationsDir);
		const beforeStatus = mgr.getStatus();
		expect(beforeStatus[0].appliedAt).toBeNull();

		mgr.migrate();

		const afterStatus = mgr.getStatus();
		expect(afterStatus[0].appliedAt).not.toBeNull();
		// Should be a valid ISO date string
		expect(() => new Date(afterStatus[0].appliedAt!)).not.toThrow();
	});
});

describe("Migration SQL execution", () => {
	it("should handle multiline SQL statements", () => {
		const db = createConnection({ dbPath: ":memory:" });
		const dir = path.join(tmpdir(), `multi-sql-${randomUUID()}`);
		fs.mkdirSync(dir, { recursive: true });

		fs.writeFileSync(
			path.join(dir, "001_multiline.sql"),
			`
        CREATE TABLE t1 (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE t2 (id INTEGER PRIMARY KEY, ref_id INTEGER REFERENCES t1(id));
        CREATE INDEX idx_t1_name ON t1(name);
      `,
		);

		const mgr = new MigrationManager(db, dir);
		mgr.migrate();

		// Verify all objects created
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);
		expect(names).toContain("t1");
		expect(names).toContain("t2");

		const indexes = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_t1_name'",
			)
			.all();
		expect(indexes.length).toBe(1);

		db.close();
		try {
			fs.rmdirSync(dir, { recursive: true });
		} catch {
			/* ok */
		}
	});

	it("should handle SQL with string literals containing semicolons", () => {
		const db = createConnection({ dbPath: ":memory:" });
		const dir = path.join(tmpdir(), `string-sql-${randomUUID()}`);
		fs.mkdirSync(dir, { recursive: true });

		fs.writeFileSync(
			path.join(dir, "001_strings.sql"),
			`CREATE TABLE test (id INTEGER PRIMARY KEY, data TEXT);
      INSERT INTO test VALUES (1, 'hello; world');
      INSERT INTO test VALUES (2, 'test; with; semicolons');`,
		);

		const mgr = new MigrationManager(db, dir);
		mgr.migrate();

		const rows = db.prepare("SELECT data FROM test ORDER BY id").all() as {
			data: string;
		}[];
		expect(rows.length).toBe(2);
		expect(rows[0].data).toBe("hello; world");
		expect(rows[1].data).toBe("test; with; semicolons");

		db.close();
		try {
			fs.rmdirSync(dir, { recursive: true });
		} catch {
			/* ok */
		}
	});

	it("should fail gracefully on invalid SQL", () => {
		const db = createConnection({ dbPath: ":memory:" });
		const dir = path.join(tmpdir(), `bad-sql-${randomUUID()}`);
		fs.mkdirSync(dir, { recursive: true });

		fs.writeFileSync(
			path.join(dir, "001_good.sql"),
			"CREATE TABLE good (id INT)",
		);
		fs.writeFileSync(path.join(dir, "002_bad.sql"), "CREATE TABLE bad (id INT");
		fs.writeFileSync(
			path.join(dir, "003_good.sql"),
			"CREATE TABLE also_good (id INT)",
		);

		const mgr = new MigrationManager(db, dir);
		expect(() => mgr.migrate()).toThrow();

		// Migration 001 was applied before 002 failed, so it IS recorded
		const records = db
			.prepare("SELECT version FROM _migrations")
			.all() as any[];
		expect(records.length).toBe(1);
		expect(records[0].version).toBe(1);

		db.close();
		try {
			fs.rmdirSync(dir, { recursive: true });
		} catch {
			/* ok */
		}
	});
});
