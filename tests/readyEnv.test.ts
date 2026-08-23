import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";

describe("CYBERLEEK.env.ready", () => {
  const content = readFileSync(
    new URL("../CYBERLEEK.env.ready", import.meta.url),
    "utf-8",
  );
  const env = parse(content) as NodeJS.ProcessEnv;

  it("is a complete parseable PAPER profile with the requested strategy", () => {
    const config = buildConfig(env);

    expect(config.trading).toMatchObject({
      mode: "paper",
      liveEnabled: false,
      maxTradeUsd: 50,
      paperBalanceUsd: 1_000,
    });
    expect(config.strategy).toMatchObject({
      takeProfitMode: "cascade",
      cascadeTakeProfitPercent: 5,
      cascadeTakeProfitSellPercent: 20,
      cascadeProfitLockEnabled: true,
      cascadeProfitLockAfterTranches: 3,
      cascadeProfitLockGainPercent: 8,
      trailingStopPercent: 12,
    });
    expect(config.autoBuy).toMatchObject({
      peakDipPercent: 6,
      volatilityMultiplier: 1.5,
      volatilityMaxDipPercent: 8,
      allowAveraging: false,
      minGapMs: 60_000,
    });
    expect(config.crashBuy).toMatchObject({
      enabled: true,
      windowMs: 12_000,
      statusHoldMs: 60_000,
    });
    expect(config.jupiter.minRequestIntervalMs).toBe(2_100);
  });

  it("contains no wallet or Jupiter secret", () => {
    expect(env.WALLET_PRIVATE_KEY).toBe("");
    expect(env.JUPITER_API_KEY).toBe("");
    expect(content).not.toMatch(/jup_[A-Za-z0-9]{20,}/);
  });

  it("contains every setting exposed by .env.example", () => {
    const example = parse(
      readFileSync(new URL("../.env.example", import.meta.url), "utf-8"),
    );
    expect(Object.keys(env).sort()).toEqual(Object.keys(example).sort());
  });
});
