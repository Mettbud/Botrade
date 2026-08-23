import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";

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
      SOL_MINT: " So11111111111111111111111111111111111111 ",
      USDC_MINT: "\tEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\t",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.token.solMint).toBe(
      "So11111111111111111111111111111111111111",
    );
    expect(config.token.usdcMint).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });
});
