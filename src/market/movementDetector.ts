import type { BotConfig } from "../config/index.js";
import type { PriceHistoryBuffer } from "./history.js";
import type { PriceSample } from "./types.js";

export type MovementKind = "PUMP" | "DUMP" | "PRICE_IMPACT_SPIKE";

export interface MovementEvent {
  kind: MovementKind;
  windowLabel: string;
  changePercent: number;
  message: string;
}

/**
 * Checks the latest sample + rolling history against configured thresholds
 * and returns any momentum/dump/impact-spike events worth surfacing.
 * Pure function over history + config so it's easy to unit test.
 */
export function detectMovements(
  history: PriceHistoryBuffer,
  latest: PriceSample,
  config: BotConfig,
): MovementEvent[] {
  const events: MovementEvent[] = [];
  const change10s = history.changePercent(10_000);
  const change30s = history.changePercent(30_000);

  if (change10s !== undefined && change10s >= config.movement.up10sPct) {
    events.push(
      pump("10s", change10s, `🚀 MOMENTUM: +${change10s.toFixed(1)}% / 10s`),
    );
  }
  if (change30s !== undefined && change30s >= config.movement.up30sPct) {
    events.push(
      pump("30s", change30s, `🚀 MOMENTUM: +${change30s.toFixed(1)}% / 30s`),
    );
  }
  if (change10s !== undefined && change10s <= -config.movement.down10sPct) {
    events.push(
      dump(
        "10s",
        change10s,
        `⚠️ DUMP DETECTED: ${change10s.toFixed(1)}% / 10s`,
      ),
    );
  }
  if (change30s !== undefined && change30s <= -config.movement.down30sPct) {
    events.push(
      dump(
        "30s",
        change30s,
        `⚠️ DUMP DETECTED: ${change30s.toFixed(1)}% / 30s`,
      ),
    );
  }

  const worstImpactBps = Math.max(
    latest.priceImpactBuyBps,
    latest.priceImpactSellBps,
  );
  if (worstImpactBps >= config.movement.priceImpactSpikeBps) {
    events.push({
      kind: "PRICE_IMPACT_SPIKE",
      windowLabel: "now",
      changePercent: worstImpactBps / 100,
      message: `⚠️ PRICE IMPACT SPIKE: ${(worstImpactBps / 100).toFixed(2)}%`,
    });
  }

  return events;
}

function pump(
  windowLabel: string,
  changePercent: number,
  message: string,
): MovementEvent {
  return { kind: "PUMP", windowLabel, changePercent, message };
}

function dump(
  windowLabel: string,
  changePercent: number,
  message: string,
): MovementEvent {
  return { kind: "DUMP", windowLabel, changePercent, message };
}
