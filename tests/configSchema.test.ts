import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";

const MINIMAL_ENV = {
  TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
} as unknown as NodeJS.ProcessEnv;

describe("config mint address handling", () => {
  it("trims stray whitespace from TARGET_TOKEN_MINT (e.g. pasted from a text editor)", () => {
    const config = buildConfig({
      TARGET_TOKEN_MINT: " ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg \n",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.token.mint).toBe(
      "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
    );
  });

  it("trims SOL_MINT and USDC_MINT the same way", () => {
    const config = buildConfig({
      TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
      SOL_MINT: " So11111111111111111111111111111111111111112 ",
      USDC_MINT: "\tEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\t",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.token.solMint).toBe(
      "So11111111111111111111111111111111111111112",
    );
    expect(config.token.usdcMint).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  // Regression test: the default SOL_MINT once had a typo (missing
  // characters) that base58-decoded to 30 bytes instead of 32. Jupiter
  // rejected every request with an opaque "WrongSize" error that gave no
  // hint it was the SOL mint, not the target token, that was wrong. Every
  // default mint address must decode to exactly a 32-byte Solana pubkey.
  it("every default mint address decodes to a valid 32-byte pubkey", () => {
    const config = buildConfig(MINIMAL_ENV);
    for (const [name, mint] of Object.entries({
      solMint: config.token.solMint,
      usdcMint: config.token.usdcMint,
      targetTokenMint: config.token.mint,
    })) {
      expect(bs58.decode(mint), `${name} (${mint})`).toHaveLength(32);
    }
  });
});

describe("adaptive auto-buy config", () => {
  it("uses conservative peak and volatility defaults", () => {
    const config = buildConfig(MINIMAL_ENV);

    expect(config.autoBuy).toMatchObject({
      peakProtectionEnabled: true,
      peakLookbackMs: 300_000,
      peakRunUpPercent: 10,
      peakDipPercent: 8,
      volatilityProtectionEnabled: true,
      volatilityLookbackMs: 60_000,
      volatilityMultiplier: 2,
      volatilityMaxDipPercent: 12,
    });
  });

  it("rejects invalid adaptive percentages and multipliers", () => {
    expect(() =>
      buildConfig({
        ...MINIMAL_ENV,
        AUTO_BUY_PEAK_DIP_PERCENT: "101",
      } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      buildConfig({
        ...MINIMAL_ENV,
        AUTO_BUY_VOLATILITY_MULTIPLIER: "-1",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

describe("cascade profit lock and crash dashboard config", () => {
  it("maps the explicit tranche-aware settings", () => {
    const config = buildConfig({
      ...MINIMAL_ENV,
      CASCADE_PROFIT_LOCK_ENABLED: "true",
      CASCADE_PROFIT_LOCK_AFTER_TRANCHES: "3",
      CASCADE_PROFIT_LOCK_GAIN_PERCENT: "8",
      CASCADE_PROFIT_LOCK_CONFIRMATION_ENABLED: "true",
      CASCADE_PROFIT_LOCK_CONFIRMATION_MS: "4000",
      CRASH_BUY_STATUS_HOLD_MS: "60000",
    } as NodeJS.ProcessEnv);

    expect(config.strategy).toMatchObject({
      cascadeProfitLockEnabled: true,
      cascadeProfitLockAfterTranches: 3,
      cascadeProfitLockGainPercent: 8,
      cascadeProfitLockConfirmationEnabled: true,
      cascadeProfitLockConfirmationMs: 4_000,
    });
    expect(config.crashBuy.statusHoldMs).toBe(60_000);
  });

  it("uses a crash window long enough for multiple normal price samples", () => {
    expect(buildConfig(MINIMAL_ENV).crashBuy.windowMs).toBe(12_000);
  });

  it("rejects a crash window shorter than one poll when crash-buy is enabled", () => {
    expect(() =>
      buildConfig({
        ...MINIMAL_ENV,
        CRASH_BUY_ENABLED: "true",
        PRICE_POLL_INTERVAL_MS: "4000",
        CRASH_BUY_WINDOW_MS: "1000",
      } as NodeJS.ProcessEnv),
    ).toThrow("CRASH_BUY_WINDOW_MS");
  });

  it("rejects a profit floor that was never reached at its activation tranche", () => {
    expect(() =>
      buildConfig({
        ...MINIMAL_ENV,
        CASCADE_TAKE_PROFIT_PERCENT: "2",
        CASCADE_PROFIT_LOCK_ENABLED: "true",
        CASCADE_PROFIT_LOCK_AFTER_TRANCHES: "3",
        CASCADE_PROFIT_LOCK_GAIN_PERCENT: "8",
      } as NodeJS.ProcessEnv),
    ).toThrow("CASCADE_PROFIT_LOCK_GAIN_PERCENT");
  });

  it("rejects invalid cascade percentages and an unreachable lock tranche", () => {
    expect(() =>
      buildConfig({
        ...MINIMAL_ENV,
        CASCADE_TAKE_PROFIT_PERCENT: "0",
      } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      buildConfig({
        ...MINIMAL_ENV,
        CASCADE_TAKE_PROFIT_SELL_PERCENT: "20",
        CASCADE_PROFIT_LOCK_ENABLED: "true",
        CASCADE_PROFIT_LOCK_AFTER_TRANCHES: "6",
      } as NodeJS.ProcessEnv),
    ).toThrow("CASCADE_PROFIT_LOCK_AFTER_TRANCHES");
  });
});
