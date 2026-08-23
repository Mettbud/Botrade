import { describe, expect, it } from "vitest";
import { checkTakeProfit } from "../src/strategy/takeProfit.js";
import { parseTakeProfitLevels } from "../src/config/takeProfitLevels.js";

const levels = parseTakeProfitLevels("20:20,40:20,70:100");

describe("takeProfit", () => {
  it("parses levels in ascending gain order", () => {
    expect(levels).toEqual([
      { gainPercent: 20, sellPercent: 20 },
      { gainPercent: 40, sellPercent: 20 },
      { gainPercent: 70, sellPercent: 100 },
    ]);
  });

  it("returns no levels below the first threshold", () => {
    expect(checkTakeProfit(15, levels, new Set())).toEqual([]);
  });

  it("returns only the level(s) reached, skipping already-triggered ones", () => {
    const due = checkTakeProfit(25, levels, new Set());
    expect(due).toEqual([{ gainPercent: 20, sellPercent: 20 }]);

    const dueAfterFirstTriggered = checkTakeProfit(25, levels, new Set([20]));
    expect(dueAfterFirstTriggered).toEqual([]);
  });

  it("returns every untriggered level reached when price jumps past several at once", () => {
    const due = checkTakeProfit(75, levels, new Set());
    expect(due).toEqual(levels);
  });

  it("never re-returns a level once marked triggered", () => {
    const due = checkTakeProfit(200, levels, new Set([20, 40, 70]));
    expect(due).toEqual([]);
  });
});
