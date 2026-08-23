import { describe, expect, it } from "vitest";
import { parseWatchPools } from "../src/config/watchPools.js";

describe("parseWatchPools", () => {
  it("returns an empty list for an empty string", () => {
    expect(parseWatchPools("")).toEqual([]);
    expect(parseWatchPools("   ")).toEqual([]);
  });

  it("parses a single pool entry", () => {
    const pools = parseWatchPools("raydium1:VaultBase111:VaultQuote111");
    expect(pools).toEqual([
      { label: "raydium1", baseVault: "VaultBase111", quoteVault: "VaultQuote111" },
    ]);
  });

  it("parses multiple comma-separated pools", () => {
    const pools = parseWatchPools("r1:B1:Q1,m1:B2:Q2");
    expect(pools).toHaveLength(2);
    expect(pools[0]!.label).toBe("r1");
    expect(pools[1]!.label).toBe("m1");
  });

  it("throws a clear error on a malformed entry (wrong field count)", () => {
    expect(() => parseWatchPools("onlylabel:onevault")).toThrow(/Invalid WATCH_POOLS entry/);
  });
});
