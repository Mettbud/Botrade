import { Connection } from "@solana/web3.js";
import type { BotConfig } from "../config/index.js";

let connection: Connection | undefined;

/** Shared singleton RPC connection, confirmed at "confirmed" commitment. */
export function getConnection(config: BotConfig): Connection {
  if (!connection) {
    connection = new Connection(config.rpc.url, {
      commitment: "confirmed",
      wsEndpoint: config.rpc.wsUrl,
    });
  }
  return connection;
}
