import type { TrailingStopState } from "../strategy/trailingStop.js";
import type { TradeMode } from "../trading/types.js";
import type { Db } from "./index.js";

interface TrailingStateRow {
  position_identity: string | null;
  highest_price_usd: number;
  armed: number;
}

const UPSERT_SQL = `
  INSERT INTO trailing_states (
    mode, position_key, position_identity, highest_price_usd, armed, updated_at
  ) VALUES (
    @mode, @positionKey, @positionIdentity, @highestPriceUsd, @armed,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT(mode, position_key) DO UPDATE SET
    position_identity = excluded.position_identity,
    highest_price_usd = excluded.highest_price_usd,
    armed = excluded.armed,
    updated_at = excluded.updated_at
`;

/** Durable high-water/armed state, isolated by trading mode and position key. */
export class TrailingStateRepo {
  private readonly selectStmt;
  private readonly upsertStmt;
  private readonly deleteStmt;
  private readonly deleteModeStmt;

  constructor(db: Db) {
    this.selectStmt = db.prepare(
      `SELECT position_identity, highest_price_usd, armed
       FROM trailing_states
       WHERE mode = ? AND position_key = ?`,
    );
    this.upsertStmt = db.prepare(UPSERT_SQL);
    this.deleteStmt = db.prepare(
      "DELETE FROM trailing_states WHERE mode = ? AND position_key = ?",
    );
    this.deleteModeStmt = db.prepare(
      "DELETE FROM trailing_states WHERE mode = ?",
    );
  }

  get(
    mode: TradeMode,
    positionKey: string,
    positionIdentity: string,
  ): TrailingStopState | undefined {
    const row = this.selectStmt.get(mode, positionKey) as
      | TrailingStateRow
      | undefined;
    if (
      !row ||
      row.position_identity !== positionIdentity ||
      !Number.isFinite(row.highest_price_usd) ||
      row.highest_price_usd <= 0 ||
      (row.armed !== 0 && row.armed !== 1)
    ) {
      return undefined;
    }
    return {
      highestPriceUsd: row.highest_price_usd,
      armed: row.armed === 1,
    };
  }

  upsert(
    mode: TradeMode,
    positionKey: string,
    positionIdentity: string,
    state: TrailingStopState,
  ): void {
    if (
      !positionKey.trim() ||
      !positionIdentity.trim() ||
      !Number.isFinite(state.highestPriceUsd) ||
      state.highestPriceUsd <= 0
    ) {
      throw new Error("Invalid trailing state");
    }
    this.upsertStmt.run({
      mode,
      positionKey,
      positionIdentity,
      highestPriceUsd: state.highestPriceUsd,
      armed: state.armed ? 1 : 0,
    });
  }

  delete(mode: TradeMode, positionKey: string): void {
    this.deleteStmt.run(mode, positionKey);
  }

  deleteByMode(mode: TradeMode): void {
    this.deleteModeStmt.run(mode);
  }
}
