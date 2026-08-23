import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/database/migrations.js";
import { TradesRepo } from "../src/database/tradesRepo.js";
import type { Trade } from "../src/trading/types.js";

function legacyTradesDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_ms INTEGER NOT NULL,
      mode TEXT NOT NULL,
      side TEXT NOT NULL,
      reason TEXT NOT NULL,
      token_amount REAL NOT NULL,
      sol_amount REAL NOT NULL,
      usd_estimate REAL NOT NULL,
      quote_before_json TEXT,
      expected_output REAL,
      actual_output REAL,
      slippage_bps REAL,
      price_impact_pct REAL,
      network_fee_lamports INTEGER,
      priority_fee_lamports INTEGER,
      tx_signature TEXT,
      realized_pnl_usd REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  runMigrations(db);
  return db;
}

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    timestampMs: 2_000,
    mode: "PAPER",
    side: "BUY",
    reason: "CRASH_BUY",
    tokenAmount: 25,
    solAmount: 0.1,
    usdEstimate: 50,
    ...overrides,
  };
}

describe("TradesRepo", () => {
  it("round-trips optional crash/cascade metadata after migrating a legacy database", () => {
    const db = legacyTradesDatabase();
    const repo = new TradesRepo(db);

    const crashId = repo.insert(
      trade({
        crashLotId: "crash-1700000000000-1",
        crashPreDropPriceUsd: 2.75,
      }),
    );
    const regularId = repo.insert(
      trade({
        timestampMs: 3_000,
        side: "SELL",
        reason: "CASCADE_TAKE_PROFIT",
        cascadeTranchesExecuted: 3,
        cascadeEntryPriceUsd: 2,
        cascadeInitialTokenAmount: 100,
      }),
    );

    const rows = repo.findAll();
    expect(rows.find((row) => row.id === crashId)).toMatchObject({
      crashLotId: "crash-1700000000000-1",
      crashPreDropPriceUsd: 2.75,
    });
    expect(rows.find((row) => row.id === regularId)).toMatchObject({
      crashLotId: undefined,
      crashPreDropPriceUsd: undefined,
      cascadeTranchesExecuted: 3,
      cascadeEntryPriceUsd: 2,
      cascadeInitialTokenAmount: 100,
    });

    db.close();
  });

  it("orders equal timestamps deterministically by insertion id", () => {
    const db = legacyTradesDatabase();
    const repo = new TradesRepo(db);

    const laterTimestampId = repo.insert(trade({ timestampMs: 2_000 }));
    const firstSameTimestampId = repo.insert(trade({ timestampMs: 1_000 }));
    const secondSameTimestampId = repo.insert(trade({ timestampMs: 1_000 }));

    expect(repo.findAll().map((row) => row.id)).toEqual([
      firstSameTimestampId,
      secondSameTimestampId,
      laterTimestampId,
    ]);

    db.close();
  });
});
