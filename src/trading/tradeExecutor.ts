import type { Trade, TradeMode, TradeReason } from "./types.js";

export interface BuyParams {
  usdAmount: number;
  reason: TradeReason;
}

export interface SellParams {
  /** Token amount (UI units) to sell. */
  tokenAmount: number;
  reason: TradeReason;
}

/**
 * Common surface for paper and live trading. `realizedPnlUsd` on the
 * returned Trade is intentionally left unset here - the caller (position
 * manager) owns the cost-basis ledger and fills it in after applying the
 * trade, since the executor itself doesn't track cost basis.
 */
export interface TradeExecutor {
  readonly mode: TradeMode;
  buy(params: BuyParams): Promise<Trade>;
  sell(params: SellParams): Promise<Trade>;
}
