import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { JupiterClient } from "../src/jupiter/client.js";
import { SolPriceTracker } from "../src/market/solPrice.js";

const MINIMAL_ENV = {
  TARGET_TOKEN_MINT: "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg",
};

function configWith(overrides: Record<string, string> = {}) {
  return buildConfig({
    ...MINIMAL_ENV,
    JUPITER_MIN_REQUEST_INTERVAL_MS: "0",
    JUPITER_429_MAX_RETRIES: "0",
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 429 ? "Too Many Requests" : "OK",
    headers,
  });
}

describe("JupiterClient shared request queue", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses conservative, bounded rate-limit defaults", () => {
    const config = buildConfig(MINIMAL_ENV as unknown as NodeJS.ProcessEnv);

    expect(config.jupiter).toMatchObject({
      minRequestIntervalMs: 2_100,
      max429Retries: 2,
      fallback429BackoffMs: 5_000,
    });
  });

  it("serializes GET and POST calls through one FIFO", async () => {
    let releaseFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(jsonResponse({ order: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new JupiterClient(configWith());

    const first = client.get<{ order: number }>("/first", {});
    const second = client.post<{ order: number }>("/second", { value: 1 });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseFirst(jsonResponse({ order: 1 }));

    await expect(first).resolves.toEqual({ order: 1 });
    await expect(second).resolves.toEqual({ order: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the configured minimum spacing between request starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      starts.push(Date.now());
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new JupiterClient(
      configWith({ JUPITER_MIN_REQUEST_INTERVAL_MS: "100" }),
    );

    await client.get("/first", {});
    const second = client.post("/second", {});

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;

    expect(starts).toEqual([0, 100]);
  });

  it("retries 429 with exponential fallback and stops at the configured bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "limited-1" }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: "limited-2" }, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new JupiterClient(
      configWith({
        JUPITER_429_MAX_RETRIES: "2",
        JUPITER_429_FALLBACK_BACKOFF_MS: "100",
      }),
    );

    const result = client.get<{ ok: boolean }>("/quote", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honors Jupiter's absolute x-ratelimit-reset timestamp", async () => {
    vi.useFakeTimers();
    const nowMs = 1_700_000_000_000;
    vi.setSystemTime(nowMs);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: "limited" }, 429, {
          "x-ratelimit-reset": String((nowMs + 2_000) / 1_000),
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new JupiterClient(
      configWith({
        JUPITER_429_MAX_RETRIES: "1",
        JUPITER_429_FALLBACK_BACKOFF_MS: "100",
      }),
    );

    const result = client.get<{ ok: boolean }>("/quote", {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps later queued work backed off after the retry budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "limited" }, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new JupiterClient(
      configWith({ JUPITER_429_FALLBACK_BACKOFF_MS: "100" }),
    );

    const failed = client.get("/first", {});
    const failure = expect(failed).rejects.toThrow(/429 Too Many Requests/);
    const next = client.get<{ ok: boolean }>("/second", {});

    await vi.advanceTimersByTimeAsync(0);
    await failure;
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(next).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a failed request poison later queued work", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "upstream" }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new JupiterClient(configWith());

    const failed = client.get("/first", {});
    const next = client.get<{ ok: boolean }>("/second", {});

    await expect(failed).rejects.toThrow(/500/);
    await expect(next).resolves.toEqual({ ok: true });
  });
});

describe("SolPriceTracker request coalescing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shares one fresh quote between simultaneous callers", async () => {
    let releaseQuote!: (response: Response) => void;
    const pendingQuote = new Promise<Response>((resolve) => {
      releaseQuote = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => pendingQuote);
    vi.stubGlobal("fetch", fetchMock);
    const config = configWith();
    const tracker = new SolPriceTracker(new JupiterClient(config), config);

    const first = tracker.getPrice();
    const second = tracker.getPrice();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseQuote(jsonResponse({ outAmount: "123000000" }));

    await expect(Promise.all([first, second])).resolves.toEqual([123, 123]);
    await expect(tracker.getPrice()).resolves.toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
