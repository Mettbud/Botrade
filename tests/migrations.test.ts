import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/database/migrations.js";

describe("runMigrations", () => {
  it("creates the trailing state table idempotently on an existing database", () => {
    const db = new Database(":memory:");

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trailing_states'",
      )
      .get() as { name: string } | undefined;
    expect(table?.name).toBe("trailing_states");
  });

  it("adds cycle identity to an early trailing-state table safely", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE trailing_states (
        mode TEXT NOT NULL,
        position_key TEXT NOT NULL,
        highest_price_usd REAL NOT NULL,
        armed INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (mode, position_key)
      );
      INSERT INTO trailing_states
        (mode, position_key, highest_price_usd, armed)
      VALUES ('PAPER', 'regular', 1.5, 1);
    `);

    expect(() => runMigrations(db)).not.toThrow();
    const row = db
      .prepare(
        "SELECT position_identity FROM trailing_states WHERE mode = 'PAPER' AND position_key = 'regular'",
      )
      .get() as { position_identity: string | null };
    expect(row.position_identity).toBeNull();
  });

  it("adds sell_is_estimated to a price_history table created before it existed", () => {
    const db = new Database(":memory:");
    // The exact old shape: a real user's database created before this column was added.
    db.exec(`
      CREATE TABLE price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        buy_price_usd REAL NOT NULL,
        sell_price_usd REAL NOT NULL,
        spread REAL NOT NULL
      )
    `);

    expect(() => runMigrations(db)).not.toThrow();

    const columns = (db.pragma("table_info(price_history)") as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain("sell_is_estimated");

    // And the column is actually usable afterwards, with the documented default.
    db.prepare(
      "INSERT INTO price_history (timestamp_ms, buy_price_usd, sell_price_usd, spread) VALUES (1, 1, 1, 0)",
    ).run();
    const row = db.prepare("SELECT sell_is_estimated FROM price_history").get() as {
      sell_is_estimated: number;
    };
    expect(row.sell_is_estimated).toBe(0);
  });

  it("is idempotent - running twice does not error or duplicate the column", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        buy_price_usd REAL NOT NULL,
        sell_price_usd REAL NOT NULL,
        spread REAL NOT NULL
      )
    `);

    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it("does nothing (no error) when the table already has the column", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sell_is_estimated INTEGER NOT NULL DEFAULT 0
      )
    `);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it("adds nullable crash/cascade metadata to a legacy trades table", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL
      )
    `);
    db.prepare("INSERT INTO trades (timestamp_ms) VALUES (?)").run(123);

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    const columns = (db.pragma("table_info(trades)") as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain("crash_lot_id");
    expect(columns).toContain("crash_pre_drop_price_usd");
    expect(columns).toContain("cascade_tranches_executed");
    expect(columns).toContain("cascade_entry_price_usd");
    expect(columns).toContain("cascade_initial_token_amount");

    const legacyRow = db
      .prepare(
        `SELECT crash_lot_id, crash_pre_drop_price_usd,
                cascade_tranches_executed, cascade_entry_price_usd,
                cascade_initial_token_amount
         FROM trades WHERE timestamp_ms = ?`,
      )
      .get(123) as {
      crash_lot_id: string | null;
      crash_pre_drop_price_usd: number | null;
      cascade_tranches_executed: number | null;
      cascade_entry_price_usd: number | null;
      cascade_initial_token_amount: number | null;
    };
    expect(legacyRow).toEqual({
      crash_lot_id: null,
      crash_pre_drop_price_usd: null,
      cascade_tranches_executed: null,
      cascade_entry_price_usd: null,
      cascade_initial_token_amount: null,
    });
  });
});
