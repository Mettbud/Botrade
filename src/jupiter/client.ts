import type { BotConfig } from "../config/index.js";

export class JupiterApiError extends Error {
  constructor(
    status: number,
    statusText: string,
    readonly body: unknown,
    request?: string,
  ) {
    super(
      `Jupiter API ${status} ${statusText}${formatBody(body)}${request ? ` (request: ${request})` : ""}`,
    );
    this.status = status;
    this.name = "JupiterApiError";
  }

  readonly status: number;
}

/**
 * Jupiter's error responses carry the actual reason (bad mint, no route,
 * invalid param) in the body - folding it into the message means it shows
 * up wherever the error is logged (`String(err)`), not just on a `.body`
 * property nobody reads in a terminal.
 */
function formatBody(body: unknown): string {
  if (body === undefined) return "";
  if (typeof body === "string") return ` - ${body}`;
  try {
    return ` - ${JSON.stringify(body)}`;
  } catch {
    return "";
  }
}

/** Thin wrapper around Jupiter's REST API - quote & swap endpoints only. */
export class JupiterClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly minRequestIntervalMs: number;
  private readonly max429Retries: number;
  private readonly fallback429BackoffMs: number;
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAtMs = 0;
  private blockedUntilMs = 0;

  constructor(config: BotConfig) {
    this.baseUrl = config.jupiter.baseUrl;
    this.apiKey = config.jupiter.apiKey;
    this.minRequestIntervalMs = config.jupiter.minRequestIntervalMs;
    this.max429Retries = config.jupiter.max429Retries;
    this.fallback429BackoffMs = config.jupiter.fallback429BackoffMs;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    return headers;
  }

  /** Never includes the key itself - just whether one is being sent, and to which host. */
  private describeEndpoint(): string {
    return `${this.baseUrl} (api key: ${this.apiKey ? "yes" : "no"})`;
  }

  async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return this.enqueue(() =>
      this.requestWith429Retry<T>(
        () => fetch(url, { headers: this.headers() }),
        () => `${this.describeEndpoint()} ${path}?${url.searchParams.toString()}`,
      ),
    );
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const serializedBody = JSON.stringify(body);
    return this.enqueue(() =>
      this.requestWith429Retry<T>(
        () =>
          fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { ...this.headers(), "Content-Type": "application/json" },
            body: serializedBody,
          }),
        () => `${this.describeEndpoint()} ${path}`,
      ),
    );
  }

  /**
   * Every endpoint shares the same FIFO. A rejected request must not poison
   * the tail, otherwise one API error would permanently block every request
   * queued after it.
   */
  private enqueue<T>(request: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(request);
    this.requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Holds its FIFO slot across retries so later calls cannot worsen a 429. */
  private async requestWith429Retry<T>(
    request: () => Promise<Response>,
    describeRequest: () => string,
  ): Promise<T> {
    let retryCount = 0;

    while (true) {
      await this.waitForRequestSlot();
      const res = await request();

      if (res.status !== 429) {
        return this.parse<T>(res, describeRequest);
      }

      const error = await this.toApiError(res, describeRequest);
      // Even when this caller has exhausted its own retry budget, preserve
      // the server's backoff for work already queued behind it. Otherwise a
      // failed request would immediately hand the same hot rate-limit bucket
      // to the next caller and create another avoidable 429.
      this.blockedUntilMs = Math.max(
        this.blockedUntilMs,
        this.resolve429RetryAtMs(res.headers, retryCount),
      );
      if (retryCount >= this.max429Retries) {
        throw error;
      }

      retryCount += 1;
    }
  }

  private async waitForRequestSlot(): Promise<void> {
    const waitMs = Math.max(
      0,
      Math.max(this.nextRequestAtMs, this.blockedUntilMs) - Date.now(),
    );
    if (waitMs > 0) {
      await delay(waitMs);
    }

    const startedAtMs = Date.now();
    this.nextRequestAtMs = startedAtMs + this.minRequestIntervalMs;
  }

  private resolve429RetryAtMs(headers: Headers, retryCount: number): number {
    const now = Date.now();
    const reset = parseDelayHeader(headers.get("x-ratelimit-reset"), now, true);
    if (reset !== undefined) return reset;

    const retryAfter = parseDelayHeader(headers.get("retry-after"), now, false);
    if (retryAfter !== undefined) return retryAfter;

    return now + this.fallback429BackoffMs * 2 ** retryCount;
  }

  private async toApiError(
    res: Response,
    describeRequest: () => string,
  ): Promise<JupiterApiError> {
    const body = await readResponseBody(res);
    return new JupiterApiError(
      res.status,
      res.statusText,
      body,
      describeRequest(),
    );
  }

  private async parse<T>(res: Response, describeRequest: () => string): Promise<T> {
    const body = await readResponseBody(res);
    if (!res.ok) {
      throw new JupiterApiError(res.status, res.statusText, body, describeRequest());
    }
    return body as T;
  }
}

/**
 * Jupiter documents x-ratelimit-reset as an absolute Unix timestamp in
 * seconds. Accepting a short relative value as well makes the client robust
 * to gateways that forward the same concept in delta-seconds. Retry-After
 * additionally permits an HTTP date.
 */
function parseDelayHeader(
  rawValue: string | null,
  nowMs: number,
  unixTimestampOnly: boolean,
): number | undefined {
  if (!rawValue) return undefined;

  const numeric = Number(rawValue);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric >= 1_000_000_000 ? numeric * 1_000 : nowMs + numeric * 1_000;
  }

  if (!unixTimestampOnly) {
    const httpDateMs = Date.parse(rawValue);
    if (Number.isFinite(httpDateMs)) return Math.max(nowMs, httpDateMs);
  }
  return undefined;
}

async function readResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  // The error body isn't always JSON (could be an HTML error page from a
  // proxy/CDN in front of the API) - never let a parse failure here hide
  // the real HTTP error behind a confusing "Unexpected token" instead.
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
