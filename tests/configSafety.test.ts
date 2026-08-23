import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { assertLiveTradingSafe, isLiveTradingArmed } from "../src/config/index.js";

const baseEnv = {
  TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
  WALLET_PRIVATE_KEY: "fake-key-for-test",
};

function envWith(overrides: Record<string, string>) {
  return { ...baseEnv, ...overrides } as unknown as NodeJS.ProcessEnv;
}

describe("live trading safety gate", () => {
  it("defaults to paper mode and is not armed", () => {
    const config = buildConfig(envWith({}));
    expect(config.trading.mode).toBe("paper");
    expect(isLiveTradingArmed(config)).toBe(false);
  });

  it("requires BOTH TRADING_MODE=live and ENABLE_LIVE_TRADING=true", () => {
    const onlyMode = buildConfig(
      envWith({ TRADING_MODE: "live", ENABLE_LIVE_TRADING: "false" }),
    );
    expect(isLiveTradingArmed(onlyMode)).toBe(false);

    const onlyFlag = buildConfig(
      envWith({ TRADING_MODE: "paper", ENABLE_LIVE_TRADING: "true" }),
    );
    expect(isLiveTradingArmed(onlyFlag)).toBe(false);

    const both = buildConfig(
      envWith({ TRADING_MODE: "live", ENABLE_LIVE_TRADING: "true" }),
    );
    expect(isLiveTradingArmed(both)).toBe(true);
  });

  it("throws if only one live switch is set (half-armed is treated as unsafe)", () => {
    const halfArmed = buildConfig(envWith({ TRADING_MODE: "live" }));
    expect(() => assertLiveTradingSafe(halfArmed)).toThrow(/TRADING_MODE=live AND ENABLE_LIVE_TRADING=true/);
  });

  it("throws if fully armed but the wallet key is empty", () => {
    const armedNoKey = buildConfig({
      TARGET_TOKEN_MINT: baseEnv.TARGET_TOKEN_MINT,
      TRADING_MODE: "live",
      ENABLE_LIVE_TRADING: "true",
    } as unknown as NodeJS.ProcessEnv);
    expect(() => assertLiveTradingSafe(armedNoKey)).toThrow(/WALLET_PRIVATE_KEY/);
  });

  it("never throws for plain paper mode, even with no wallet key", () => {
    const paperNoKey = buildConfig({
      TARGET_TOKEN_MINT: baseEnv.TARGET_TOKEN_MINT,
    } as unknown as NodeJS.ProcessEnv);
    expect(() => assertLiveTradingSafe(paperNoKey)).not.toThrow();
  });
});
