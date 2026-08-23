import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/database/migrations.js";
import { TrailingStateRepo } from "../src/database/trailingStateRepo.js";

function setup() {
  const db = new Database(":memory:");
  runMigrations(db);
  return { db, repo: new TrailingStateRepo(db) };
}

describe("TrailingStateRepo", () => {
  it("upserts independently by mode, position key and cycle identity", () => {
    const { repo } = setup();
    repo.upsert("PAPER", "regular", "trade:1", {
      highestPriceUsd: 1.5,
      armed: true,
    });
    repo.upsert("PAPER", "crash:lot-1", "lot-1", {
      highestPriceUsd: 0.75,
      armed: false,
    });

    expect(repo.get("PAPER", "regular", "trade:1")).toEqual({
      highestPriceUsd: 1.5,
      armed: true,
    });
    expect(repo.get("PAPER", "regular", "trade:old")).toBeUndefined();
    expect(repo.get("PAPER", "crash:lot-1", "lot-1")).toEqual({
      highestPriceUsd: 0.75,
      armed: false,
    });
    expect(repo.get("LIVE", "regular", "trade:1")).toBeUndefined();
  });

  it("rejects invalid persisted values on read", () => {
    const { db, repo } = setup();
    db.prepare(
      `INSERT INTO trailing_states
       (mode, position_key, position_identity, highest_price_usd, armed)
       VALUES ('PAPER', 'regular', 'trade:1', -1, 2)`,
    ).run();

    expect(repo.get("PAPER", "regular", "trade:1")).toBeUndefined();
  });

  it("deletes one key or every state for a mode", () => {
    const { repo } = setup();
    repo.upsert("PAPER", "regular", "trade:1", {
      highestPriceUsd: 2,
      armed: true,
    });
    repo.upsert("PAPER", "crash:one", "one", {
      highestPriceUsd: 1,
      armed: false,
    });
    repo.upsert("LIVE", "regular", "trade:9", {
      highestPriceUsd: 3,
      armed: true,
    });

    repo.delete("PAPER", "regular");
    expect(repo.get("PAPER", "regular", "trade:1")).toBeUndefined();
    expect(repo.get("PAPER", "crash:one", "one")).toBeDefined();

    repo.deleteByMode("PAPER");
    expect(repo.get("PAPER", "crash:one", "one")).toBeUndefined();
    expect(repo.get("LIVE", "regular", "trade:9")).toBeDefined();
  });
});
