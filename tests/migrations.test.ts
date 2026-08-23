import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/database/migrations.js";

describe("runMigrations", () => {
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
});
