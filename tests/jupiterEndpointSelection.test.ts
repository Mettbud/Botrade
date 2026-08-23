import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { JupiterClient } from "../src/jupiter/client.js";

const BASE_ENV = {
  TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
  // Endpoint-selection tests intentionally inspect the first 429 rather
  // than exercising retry timing (covered by jupiterRateLimit.test.ts).
  JUPITER_MIN_REQUEST_INTERVAL_MS: "0",
  JUPITER_429_MAX_RETRIES: "0",
};

function fakeErrorResponse() {
  return new Response(JSON.stringify({ code: 429, message: "rate limited" }), {
    status: 429,
    statusText: "Too Many Requests",
  });
}

describe("JupiterClient endpoint selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses lite-api.jup.ag with no key, and the error says so", async () => {
    const config = buildConfig(BASE_ENV as unknown as NodeJS.ProcessEnv);
    const client = new JupiterClient(config);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeErrorResponse()));

    await expect(
      client.get("/swap/v1/quote", { inputMint: "a", outputMint: "b", amount: "1" }),
    ).rejects.toThrow(/lite-api\.jup\.ag.*api key: no/);
  });

  it("switches to api.jup.ag once a (trimmed) key is set, and the error confirms it", async () => {
    const config = buildConfig({
      ...BASE_ENV,
      JUPITER_API_KEY: " my-key \n",
    } as unknown as NodeJS.ProcessEnv);
    const client = new JupiterClient(config);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeErrorResponse()));

    await expect(
      client.get("/swap/v1/quote", { inputMint: "a", outputMint: "b", amount: "1" }),
    ).rejects.toThrow(/api\.jup\.ag.*api key: yes/);
    expect(config.jupiter.apiKey).toBe("my-key"); // trimmed, no stray whitespace
  });
});
