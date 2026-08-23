import { describe, expect, it } from "vitest";
import { priceFromReserves } from "../src/onchain/poolPrice.js";

describe("priceFromReserves", () => {
  it("computes price as quote-per-base for equal decimals", () => {
    // 1,000,000 base tokens, 50 quote (SOL) -> price = 50 / 1,000,000 = 0.00005
    const price = priceFromReserves(1_000_000n, 0, 50n, 0);
    expect(price).toBeCloseTo(0.00005, 12);
  });

  it("accounts for different decimals between base and quote", () => {
    // 1,000,000 base tokens (6 decimals) vs 50 SOL (9 decimals)
    const baseRaw = 1_000_000n * 10n ** 6n;
    const quoteRaw = 50n * 10n ** 9n;
    const price = priceFromReserves(baseRaw, 6, quoteRaw, 9);
    expect(price).toBeCloseTo(50 / 1_000_000, 12);
  });

  it("reacts to a reserve shift the way a real dip would", () => {
    // dump: someone sells a lot of base into the pool, base reserve goes up,
    // quote (SOL) reserve goes down -> price falls, consistent with x*y=k
    const before = priceFromReserves(1_000_000n, 0, 50n, 0);
    const after = priceFromReserves(1_500_000n, 0, 33n, 0); // roughly along x*y=k
    expect(after).toBeLessThan(before);
  });

  it("returns 0 instead of throwing/NaN on an empty base reserve", () => {
    expect(priceFromReserves(0n, 0, 50n, 0)).toBe(0);
  });
});
