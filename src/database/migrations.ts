import type { Db } from "./index.js";

/**
 * `CREATE TABLE IF NOT EXISTS` (in schema.sql) only helps on a brand new
 * database - a database created before some column existed just keeps
 * missing it forever, and the very next query referencing that column
 * crashes with "no such column". Each entry here backfills one column
 * onto an already-existing table; safe to run every startup since it
 * only acts when the column is actually missing.
 */
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  {
    table: "price_history",
    column: "sell_is_estimated",
    ddl: "ALTER TABLE price_history ADD COLUMN sell_is_estimated INTEGER NOT NULL DEFAULT 0",
  },
];

function existingColumns(db: Db, table: string): Set<string> {
  const rows = db.pragma(`table_info(${table})`) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Applies any pending column migrations. Idempotent - safe to call every startup. */
export function runMigrations(db: Db): void {
  const columnsByTable = new Map<string, Set<string>>();

  for (const migration of COLUMN_MIGRATIONS) {
    let columns = columnsByTable.get(migration.table);
    if (!columns) {
      columns = existingColumns(db, migration.table);
      columnsByTable.set(migration.table, columns);
    }
    if (!columns.has(migration.column)) {
      db.exec(migration.ddl);
      columns.add(migration.column);
    }
  }
}
