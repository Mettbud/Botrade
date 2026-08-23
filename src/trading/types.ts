export type TradeSide = "BUY" | "SELL";
export type TradeMode = "PAPER" | "LIVE";
export type TradeReason =
  | "MANUAL"
  | "AUTO_BUY"
  | "STOP_LOSS"
  | "TRAILING_STOP"
  | "TAKE_PROFIT"
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
}

export interface TradeRow extends Trade {
  id: number;
  createdAt: string;
}
