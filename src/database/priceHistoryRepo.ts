import type { Db } from "./index.js";
import type { PriceSample } from "../market/types.js";

export interface PriceChanges {
  change5s?: number;
  change15s?: number;
  change30s?: number;
  change1m?: number;
  change5m?: number;
}

const INSERT_SQL = `
  INSERT INTO price_history (
    timestamp_ms, buy_price_usd, sell_price_usd, spread,
    price_impact_buy_bps, price_impact_sell_bps, sol_usd_price,
    change_5s, change_15s, change_30s, change_1m, change_5m
  ) VALUES (
    @timestampMs, @buyPriceUsd, @sellPriceUsd, @spread,
    @priceImpactBuyBps, @priceImpactSellBps, @solUsdPrice,
    @change5s, @change15s, @change30s, @change1m, @change5m
  )
`;

export class PriceHistoryRepo {
  private readonly insertStmt;

  constructor(db: Db) {
    this.insertStmt = db.prepare(INSERT_SQL);
  }

  insert(sample: PriceSample, changes: PriceChanges): void {
    this.insertStmt.run({
      timestampMs: sample.timestampMs,
      buyPriceUsd: sample.buyPriceUsd,
      sellPriceUsd: sample.sellPriceUsd,
      spread: sample.spread,
      priceImpactBuyBps: sample.priceImpactBuyBps,
      priceImpactSellBps: sample.priceImpactSellBps,
      solUsdPrice: sample.solUsdPrice,
      change5s: changes.change5s ?? null,
      change15s: changes.change15s ?? null,
      change30s: changes.change30s ?? null,
      change1m: changes.change1m ?? null,
      change5m: changes.change5m ?? null,
    });
  }
}
