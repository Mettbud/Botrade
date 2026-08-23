import type { Db } from "./index.js";
import type { Trade, TradeRow } from "../trading/types.js";

const INSERT_SQL = `
  INSERT INTO trades (
    timestamp_ms, mode, side, reason, token_amount, sol_amount, usd_estimate,
    quote_before_json, expected_output, actual_output, slippage_bps,
    price_impact_pct, network_fee_lamports, priority_fee_lamports,
    tx_signature, realized_pnl_usd, crash_lot_id, crash_pre_drop_price_usd,
    cascade_tranches_executed, cascade_entry_price_usd,
    cascade_initial_token_amount
  ) VALUES (
    @timestampMs, @mode, @side, @reason, @tokenAmount, @solAmount, @usdEstimate,
    @quoteBeforeJson, @expectedOutput, @actualOutput, @slippageBps,
    @priceImpactPct, @networkFeeLamports, @priorityFeeLamports,
    @txSignature, @realizedPnlUsd, @crashLotId, @crashPreDropPriceUsd,
    @cascadeTranchesExecuted, @cascadeEntryPriceUsd,
    @cascadeInitialTokenAmount
  )
`;

interface TradeRowRaw {
  id: number;
  timestamp_ms: number;
  mode: string;
  side: string;
  reason: string;
  token_amount: number;
  sol_amount: number;
  usd_estimate: number;
  quote_before_json: string | null;
  expected_output: number | null;
  actual_output: number | null;
  slippage_bps: number | null;
  price_impact_pct: number | null;
  network_fee_lamports: number | null;
  priority_fee_lamports: number | null;
  tx_signature: string | null;
  realized_pnl_usd: number | null;
  crash_lot_id: string | null;
  crash_pre_drop_price_usd: number | null;
  cascade_tranches_executed: number | null;
  cascade_entry_price_usd: number | null;
  cascade_initial_token_amount: number | null;
  created_at: string;
}

export class TradesRepo {
  private readonly insertStmt;
  private readonly selectAllStmt;

  constructor(private readonly db: Db) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.selectAllStmt = db.prepare(
      "SELECT * FROM trades ORDER BY timestamp_ms ASC, id ASC",
    );
  }

  insert(trade: Trade): number {
    const info = this.insertStmt.run({
      timestampMs: trade.timestampMs,
      mode: trade.mode,
      side: trade.side,
      reason: trade.reason,
      tokenAmount: trade.tokenAmount,
      solAmount: trade.solAmount,
      usdEstimate: trade.usdEstimate,
      quoteBeforeJson: trade.quoteBeforeJson ?? null,
      expectedOutput: trade.expectedOutput ?? null,
      actualOutput: trade.actualOutput ?? null,
      slippageBps: trade.slippageBps ?? null,
      priceImpactPct: trade.priceImpactPct ?? null,
      networkFeeLamports: trade.networkFeeLamports ?? null,
      priorityFeeLamports: trade.priorityFeeLamports ?? null,
      txSignature: trade.txSignature ?? null,
      realizedPnlUsd: trade.realizedPnlUsd ?? null,
      crashLotId: trade.crashLotId ?? null,
      crashPreDropPriceUsd: trade.crashPreDropPriceUsd ?? null,
      cascadeTranchesExecuted: trade.cascadeTranchesExecuted ?? null,
      cascadeEntryPriceUsd: trade.cascadeEntryPriceUsd ?? null,
      cascadeInitialTokenAmount: trade.cascadeInitialTokenAmount ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  /** All trades in chronological order - the source of truth for cost basis replay. */
  findAll(): TradeRow[] {
    return (this.selectAllStmt.all() as TradeRowRaw[]).map(fromRaw);
  }

  /** Wipes every trade for one mode - used by the "reset" CLI command (PAPER only). */
  deleteByMode(mode: Trade["mode"]): number {
    const info = this.db.prepare("DELETE FROM trades WHERE mode = ?").run(mode);
    return info.changes;
  }
}

function fromRaw(row: TradeRowRaw): TradeRow {
  return {
    id: row.id,
    timestampMs: row.timestamp_ms,
    mode: row.mode as TradeRow["mode"],
    side: row.side as TradeRow["side"],
    reason: row.reason as TradeRow["reason"],
    tokenAmount: row.token_amount,
    solAmount: row.sol_amount,
    usdEstimate: row.usd_estimate,
    quoteBeforeJson: row.quote_before_json ?? undefined,
    expectedOutput: row.expected_output ?? undefined,
    actualOutput: row.actual_output ?? undefined,
    slippageBps: row.slippage_bps ?? undefined,
    priceImpactPct: row.price_impact_pct ?? undefined,
    networkFeeLamports: row.network_fee_lamports ?? undefined,
    priorityFeeLamports: row.priority_fee_lamports ?? undefined,
    txSignature: row.tx_signature ?? undefined,
    realizedPnlUsd: row.realized_pnl_usd ?? undefined,
    crashLotId: row.crash_lot_id ?? undefined,
    crashPreDropPriceUsd: row.crash_pre_drop_price_usd ?? undefined,
    cascadeTranchesExecuted: row.cascade_tranches_executed ?? undefined,
    cascadeEntryPriceUsd: row.cascade_entry_price_usd ?? undefined,
    cascadeInitialTokenAmount: row.cascade_initial_token_amount ?? undefined,
    createdAt: row.created_at,
  };
}
