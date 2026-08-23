export type TradeSide = "BUY" | "SELL";
export type TradeMode = "PAPER" | "LIVE";
export type TradeReason =
  | "MANUAL"
  | "AUTO_BUY"
  | "CRASH_BUY"
  | "CRASH_BUY_EXIT"
  | "STOP_LOSS"
  | "TRAILING_STOP"
  | "REGULAR_STOP_LOSS"
  | "REGULAR_TRAILING_STOP"
  | "CRASH_STOP_LOSS"
  | "CRASH_TRAILING_STOP"
  | "TAKE_PROFIT"
  | "CASCADE_TAKE_PROFIT"
  | "PROFIT_LOCK"
  | "PANIC_EXIT";

/** A single executed (or simulated) trade, ready to persist and to fold into cost basis. */
export interface Trade {
  timestampMs: number;
  mode: TradeMode;
  side: TradeSide;
  reason: TradeReason;
  tokenAmount: number;
  solAmount: number;
  usdEstimate: number;
  quoteBeforeJson?: string;
  expectedOutput?: number;
  actualOutput?: number;
  slippageBps?: number;
  priceImpactPct?: number;
  networkFeeLamports?: number;
  priorityFeeLamports?: number;
  txSignature?: string;
  realizedPnlUsd?: number;
  /** Stable identifier linking a crash-buy entry with its dedicated exit(s). */
  crashLotId?: string;
  /** Price immediately before the crash, used as this lot's rebound target. */
  crashPreDropPriceUsd?: number;
  /** Number of linear cascade thresholds fulfilled by this executed sell. */
  cascadeTranchesExecuted?: number;
  /** Frozen regular-position entry used for this cascade cycle. */
  cascadeEntryPriceUsd?: number;
  /** Frozen regular token amount from which fixed tranche sizes are derived. */
  cascadeInitialTokenAmount?: number;
}

export interface TradeRow extends Trade {
  id: number;
  createdAt: string;
}
