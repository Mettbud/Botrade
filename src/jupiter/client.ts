import type { BotConfig } from "../config/index.js";

export class JupiterApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "JupiterApiError";
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
    const body = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw new JupiterApiError(
        `Jupiter API ${res.status} ${res.statusText}`,
        res.status,
        body,
      );
    }
    return body as T;
  }
}
