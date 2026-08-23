import type { BotConfig } from "../config/index.js";

export class JupiterApiError extends Error {
  constructor(
    status: number,
    statusText: string,
    readonly body: unknown,
  ) {
    super(`Jupiter API ${status} ${statusText}${formatBody(body)}`);
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

  constructor(config: BotConfig) {
    this.baseUrl = config.jupiter.baseUrl;
    this.apiKey = config.jupiter.apiKey;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    return headers;
  }

  async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const res = await fetch(url, { headers: this.headers() });
    return this.parse<T>(res);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    // The error body isn't always JSON (could be an HTML error page from a
    // proxy/CDN in front of the API) - never let a parse failure here hide
    // the real HTTP error behind a confusing "Unexpected token" instead.
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      throw new JupiterApiError(res.status, res.statusText, body);
    }
    return body as T;
  }
}
