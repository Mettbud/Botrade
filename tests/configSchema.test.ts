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
