type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLOR: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

/** Redacts anything that looks like it could be a secret key/seed value. */
const SECRET_KEYS = new Set([
  "privatekey",
  "secretkey",
  "seed",
  "seedphrase",
  "mnemonic",
]);

function redact(meta: Record<string, unknown> | undefined) {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
}

export class Logger {
  constructor(private readonly minLevel: Level = "info") {}

  private log(level: Level, message: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const ts = new Date().toISOString();
    const safeMeta = redact(meta);
    const suffix = safeMeta ? ` ${JSON.stringify(safeMeta)}` : "";
    const line = `${COLOR[level]}[${ts}] ${level.toUpperCase()}${RESET} ${message}${suffix}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.log("debug", message, meta);
  }
  info(message: string, meta?: Record<string, unknown>) {
    this.log("info", message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>) {
    this.log("warn", message, meta);
  }
  error(message: string, meta?: Record<string, unknown>) {
    this.log("error", message, meta);
  }
}

export function createLogger(level: Level = "info"): Logger {
  return new Logger(level);
}
