import type { Db } from "./index.js";

const TABLE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS trailing_states (
    mode TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
    position_key TEXT NOT NULL,
    position_identity TEXT NOT NULL,
    highest_price_usd REAL NOT NULL,
    armed INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (mode, position_key)
  )`,
];

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
  {
    table: "trades",
    column: "crash_lot_id",
    ddl: "ALTER TABLE trades ADD COLUMN crash_lot_id TEXT",
  },
  {
    table: "trades",
    column: "crash_pre_drop_price_usd",
    ddl: "ALTER TABLE trades ADD COLUMN crash_pre_drop_price_usd REAL",
  },
  {
    table: "trades",
    column: "cascade_tranches_executed",
    ddl: "ALTER TABLE trades ADD COLUMN cascade_tranches_executed INTEGER",
  },
  {
    table: "trades",
    column: "cascade_entry_price_usd",
    ddl: "ALTER TABLE trades ADD COLUMN cascade_entry_price_usd REAL",
  },
  {
    table: "trades",
    column: "cascade_initial_token_amount",
    ddl: "ALTER TABLE trades ADD COLUMN cascade_initial_token_amount REAL",
  },
  {
    table: "trailing_states",
    column: "position_identity",
    ddl: "ALTER TABLE trailing_states ADD COLUMN position_identity TEXT",
  },
];

function existingColumns(db: Db, table: string): Set<string> | undefined {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return undefined;

  const rows = db.pragma(`table_info(${table})`) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Applies any pending column migrations. Idempotent - safe to call every startup. */
export function runMigrations(db: Db): void {
  for (const ddl of TABLE_MIGRATIONS) db.exec(ddl);

  const columnsByTable = new Map<string, Set<string> | undefined>();

  for (const migration of COLUMN_MIGRATIONS) {
    let columns = columnsByTable.get(migration.table);
    if (!columnsByTable.has(migration.table)) {
      columns = existingColumns(db, migration.table);
      columnsByTable.set(migration.table, columns);
    }
    // openDatabase creates the current schema before applying migrations. Keeping
    // this helper tolerant of a missing table also makes standalone migrations
    // safe while a database is being created or repaired.
    if (!columns) continue;

    if (!columns.has(migration.column)) {
      db.exec(migration.ddl);
      columns.add(migration.column);
    }
  }
}
