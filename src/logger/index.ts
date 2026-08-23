import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

/**
 * Logs to the console AND, if `filePath` is given, appends a plain-text
 * (no ANSI colors) copy to a file. The dashboard clears the terminal every
 * second, so anything printed only to the console can flash and vanish
 * before anyone reads it - the file is the durable record.
 */
export class Logger {
  constructor(
    private readonly minLevel: Level = "info",
    private readonly filePath?: string,
  ) {
    if (this.filePath) mkdirSync(dirname(this.filePath), { recursive: true });
  }

  private log(level: Level, message: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const ts = new Date().toISOString();
    const safeMeta = redact(meta);
    const suffix = safeMeta ? ` ${JSON.stringify(safeMeta)}` : "";
    const plain = `[${ts}] ${level.toUpperCase()} ${message}${suffix}`;

    if (level === "error") console.error(`${COLOR[level]}${plain}${RESET}`);
    else if (level === "warn") console.warn(`${COLOR[level]}${plain}${RESET}`);
    else console.log(`${COLOR[level]}${plain}${RESET}`);

    if (this.filePath) {
      try {
        appendFileSync(this.filePath, plain + "\n");
      } catch {
        // Never let a logging failure crash the bot.
      }
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

export function createLogger(level: Level = "info", filePath?: string): Logger {
  return new Logger(level, filePath);
}
