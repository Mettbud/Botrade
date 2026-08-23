import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { PriceHistoryBuffer } from "../src/market/history.js";
import { detectMovements } from "../src/market/movementDetector.js";
import type { PriceSample } from "../src/market/types.js";

const config = buildConfig({
  TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
  MOMENTUM_UP_10S_PCT: "5",
  MOMENTUM_UP_30S_PCT: "10",
  MOMENTUM_DOWN_10S_PCT: "5",
  MOMENTUM_DOWN_30S_PCT: "10",
  PRICE_IMPACT_SPIKE_BPS: "200",
} as unknown as NodeJS.ProcessEnv);

function sample(timestampMs: number, sellPriceUsd: number, impactBps = 10): PriceSample {
  return {
    timestampMs,
    buyPriceUsd: sellPriceUsd,
    sellPriceUsd,
    spread: 0,
    priceImpactBuyBps: impactBps,
    priceImpactSellBps: impactBps,
    referenceSolAmount: 0.01,
    referenceTokenAmountUi: 100,
    solUsdPrice: 150,
  };
}

describe("detectMovements", () => {
  it("flags a pump when 10s change crosses the threshold", () => {
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    const latest = sample(10_000, 1.06); // +6%
    history.push(latest);

    const events = detectMovements(history, latest, config);
    expect(events.some((e) => e.kind === "PUMP" && e.windowLabel === "10s")).toBe(true);
  });

  it("flags a dump when 30s change crosses the negative threshold", () => {
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    const latest = sample(30_000, 0.85); // -15%
    history.push(latest);

    const events = detectMovements(history, latest, config);
    expect(events.some((e) => e.kind === "DUMP" && e.windowLabel === "30s")).toBe(true);
  });

  it("does not flag anything for a small, ordinary move", () => {
    const history = new PriceHistoryBuffer();
    history.push(sample(0, 1.0));
    const latest = sample(10_000, 1.01); // +1%
    history.push(latest);

    expect(detectMovements(history, latest, config)).toEqual([]);
  });

  it("flags a price impact spike from the latest sample alone", () => {
    const history = new PriceHistoryBuffer();
    const latest = sample(0, 1.0, 250); // 2.5% impact > 200bps threshold
    history.push(latest);

    const events = detectMovements(history, latest, config);
    expect(events.some((e) => e.kind === "PRICE_IMPACT_SPIKE")).toBe(true);
  });
});
