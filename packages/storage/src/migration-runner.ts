import { DatabaseSync } from "node:sqlite";

type SqlRow = Record<string, unknown>;

export class MigrationRunner {
  constructor(private readonly db: DatabaseSync) {}

  apply(key: string, migrate: () => void): void {
    const applied = this.db
      .prepare("SELECT 1 FROM schema_migrations WHERE migration_key = ?")
      .get(key);
    if (applied) return;
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

  ensureColumn(table: string, column: string, definition: string): void {
    if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) {
      throw new Error("Unsafe schema identifier");
    }
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
