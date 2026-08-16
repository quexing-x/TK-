import { DatabaseSync } from "node:sqlite";

type SqlRow = Record<string, unknown>;

export class MigrationRunner {
  private firstMigrationHandled = false;

  // onBeforeFirstMigration 在"本次启动第一条真正要落库的迁移"执行前回调一次——
  // 用来把整库的迁移前备份改成按需触发：schema 已最新的常规启动没有任何迁移会跑，
  // 回调不触发、备份也不做。回调必须在事务外执行（备份用 VACUUM INTO 不能在事务里），
  // 所以它在 apply 的 BEGIN 之前、ensureColumn 的 ALTER 之前触发。
  constructor(
    private readonly db: DatabaseSync,
    private readonly onBeforeFirstMigration?: () => void,
  ) {}

  private triggerBeforeFirstMigration(): void {
    if (this.firstMigrationHandled) return;
    this.firstMigrationHandled = true;
    this.onBeforeFirstMigration?.();
  }

  apply(key: string, migrate: () => void): void {
    const applied = this.db
      .prepare("SELECT 1 FROM schema_migrations WHERE migration_key = ?")
      .get(key);
    if (applied) return;
    this.triggerBeforeFirstMigration();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      migrate();
      this.db.prepare(
        "INSERT INTO schema_migrations (migration_key, applied_at) VALUES (?, ?)",
      ).run(key, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  applyWithForeignKeysDisabled(key: string, migrate: () => void): void {
    const applied = this.db
      .prepare("SELECT 1 FROM schema_migrations WHERE migration_key = ?")
      .get(key);
    if (applied) return;
    this.triggerBeforeFirstMigration();
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      migrate();
      const violations = this.db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(`Foreign key check failed during migration ${key}`);
      }
      this.db.prepare(
        "INSERT INTO schema_migrations (migration_key, applied_at) VALUES (?, ?)",
      ).run(key, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  ensureColumn(table: string, column: string, definition: string): void {
    if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) {
      throw new Error("Unsafe schema identifier");
    }
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (!columns.some((item) => item.name === column)) {
      this.triggerBeforeFirstMigration();
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
