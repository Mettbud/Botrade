import { describe, expect, it } from "vitest";
import { tokenAmountFromSignedDelta } from "../src/trading/liveTrader.js";

describe("tokenAmountFromSignedDelta", () => {
  it("accepts only a positive token delta for a buy", () => {
    expect(tokenAmountFromSignedDelta(1_230_000n, 6, "BUY")).toBe(1.23);
    expect(tokenAmountFromSignedDelta(0n, 6, "BUY")).toBeUndefined();
    expect(tokenAmountFromSignedDelta(-1_230_000n, 6, "BUY")).toBeUndefined();
  });

  it("accepts only a negative token delta for a sell", () => {
    expect(tokenAmountFromSignedDelta(-1_230_000n, 6, "SELL")).toBe(1.23);
    expect(tokenAmountFromSignedDelta(0n, 6, "SELL")).toBeUndefined();
    expect(tokenAmountFromSignedDelta(1_230_000n, 6, "SELL")).toBeUndefined();
  });
});
