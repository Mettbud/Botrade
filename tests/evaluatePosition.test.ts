import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { applyTrade, EMPTY_COST_BASIS } from "../src/strategy/costBasis.js";
import { evaluatePosition } from "../src/strategy/evaluatePosition.js";
import { initTrailingStop } from "../src/strategy/trailingStop.js";

function configWith(overrides: Record<string, string>) {
  return buildConfig({
    TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
    TRAILING_STOP_PERCENT: "12",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

describe("evaluatePosition trailing-stop scaling", () => {
  it("uses the flat TRAILING_STOP_PERCENT when TRAILING_STOP_LEVELS is unset", () => {
    const config = configWith({});
    // entry $1, position bought for $100 -> 100 tokens
    const costBasis = applyTrade(EMPTY_COST_BASIS, { side: "BUY", tokenAmount: 100, usdEstimate: 100 });
    const evaluation = evaluatePosition(costBasis, 1.0, initTrailingStop(1.0), new Set(), config);
    expect(evaluation.trailing.appliedPercent).toBe(12);
  });

  it("scales the applied trailing-stop % once the peak gain crosses a level", () => {
    const config = configWith({ TRAILING_STOP_LEVELS: "50:18,200:25" });
    const costBasis = applyTrade(EMPTY_COST_BASIS, { side: "BUY", tokenAmount: 100, usdEstimate: 100 }); // entry $1

    // Price at $1.60 -> peak gain 60%, crosses the 50% level -> 18% applies.
    const evaluation = evaluatePosition(costBasis, 1.6, initTrailingStop(1.0), new Set(), config);
    expect(evaluation.trailing.appliedPercent).toBe(18);
  });

  it("triggers at the wider (scaled) tolerance instead of the flat default", () => {
    const config = configWith({ TRAILING_STOP_LEVELS: "50:18" });
    const costBasis = applyTrade(EMPTY_COST_BASIS, { side: "BUY", tokenAmount: 100, usdEstimate: 100 }); // entry $1

    let trailingState = initTrailingStop(1.0);
    let evaluation = evaluatePosition(costBasis, 1.6, trailingState, new Set(), config); // peak $1.60
    trailingState = evaluation.trailing.state;

    // Drawdown of 14% from the $1.60 peak ($1.376) - would trigger the flat
    // 12% default, but should NOT trigger the scaled 18% tolerance.
    evaluation = evaluatePosition(costBasis, 1.376, trailingState, new Set(), config);
    expect(evaluation.trailing.appliedPercent).toBe(18);
    expect(evaluation.trailing.triggered).toBe(false);
  });
});
