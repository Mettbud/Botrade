import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { BotConfig } from "../config/index.js";

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), {
  encoding: "utf-8",
});

export type Db = Database.Database;

/** Opens (creating if needed) the local SQLite database and applies the schema. */
export function openDatabase(config: BotConfig): Db {
  if (config.storage.dbPath !== ":memory:") {
    mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  }
  const db = new Database(config.storage.dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  return db;
}
