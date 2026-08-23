import { describe, expect, it } from "vitest";
import { findMissingEnvKeys } from "../src/config/envDrift.js";

const EXAMPLE = `
# a comment, not a key
WALLET_PRIVATE_KEY=
RPC_URL=https://api.mainnet-beta.solana.com
AUTO_BUY_ENABLED=false
AUTO_BUY_DIP_PERCENT=50
`;

describe("findMissingEnvKeys", () => {
  it("finds keys declared in .env.example but absent from the actual env", () => {
    const missing = findMissingEnvKeys(EXAMPLE, {
      WALLET_PRIVATE_KEY: "abc",
      RPC_URL: "https://x",
      // AUTO_BUY_ENABLED / AUTO_BUY_DIP_PERCENT missing - an older .env
    } as NodeJS.ProcessEnv);

    expect(missing).toEqual(["AUTO_BUY_ENABLED", "AUTO_BUY_DIP_PERCENT"]);
  });

  it("reports nothing missing when the env is fully up to date", () => {
    const missing = findMissingEnvKeys(EXAMPLE, {
      WALLET_PRIVATE_KEY: "abc",
      RPC_URL: "https://x",
      AUTO_BUY_ENABLED: "false",
      AUTO_BUY_DIP_PERCENT: "50",
    } as NodeJS.ProcessEnv);

    expect(missing).toEqual([]);
  });

  it("treats an empty string value as present, not missing (e.g. WALLET_PRIVATE_KEY=)", () => {
    const missing = findMissingEnvKeys(EXAMPLE, {
      WALLET_PRIVATE_KEY: "",
      RPC_URL: "https://x",
      AUTO_BUY_ENABLED: "false",
      AUTO_BUY_DIP_PERCENT: "50",
    } as NodeJS.ProcessEnv);

    expect(missing).toEqual([]);
  });

  it("ignores comment lines", () => {
    const missing = findMissingEnvKeys(EXAMPLE, {} as NodeJS.ProcessEnv);
    expect(missing).not.toContain("a");
  });
});
