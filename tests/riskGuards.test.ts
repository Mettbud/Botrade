import { describe, expect, it } from "vitest";
import {
  checkMaxTradeSize,
  checkPriceImpact,
  checkSlippage,
  checkSolReserve,
} from "../src/trading/riskGuards.js";

describe("riskGuards", () => {
  describe("checkMaxTradeSize", () => {
    it("allows a trade at or under the cap", () => {
      expect(checkMaxTradeSize(1, 1).allowed).toBe(true);
      expect(checkMaxTradeSize(0.5, 1).allowed).toBe(true);
    });

    it("blocks a trade over MAX_TRADE_USD", () => {
      const result = checkMaxTradeSize(1.01, 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/MAX_TRADE_USD/);
    });
  });

  describe("checkSolReserve", () => {
    it("allows spending that leaves the reserve intact", () => {
      expect(checkSolReserve(1, 0.5, 0.05).allowed).toBe(true);
    });

    it("blocks spending that would eat into MIN_SOL_RESERVE", () => {
      const result = checkSolReserve(0.1, 0.08, 0.05);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/MIN_SOL_RESERVE/);
    });

    it("blocks spending the entire balance", () => {
      const result = checkSolReserve(1, 1, 0.05);
      expect(result.allowed).toBe(false);
    });
  });

  describe("checkSlippage / checkPriceImpact", () => {
    it("blocks when slippage exceeds the configured max", () => {
      expect(checkSlippage(200, 150).allowed).toBe(false);
      expect(checkSlippage(100, 150).allowed).toBe(true);
    });

    it("blocks when price impact exceeds the configured max", () => {
      const result = checkPriceImpact(400, 300);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/TRADE BLOCKED/);
    });
  });
});
