import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { BotConfig } from "../config/index.js";

/**
 * Loads the bot's dedicated hot wallet keypair from config.
 *
 * Accepts either a base58-encoded secret key string (the documented format)
 * or a JSON array of bytes (what `solana-keygen` prints), so users who
 * paste either format into WALLET_PRIVATE_KEY still work.
 *
 * The raw key material is never logged, returned as a string, or sent
 * anywhere - it only ever becomes an in-memory Keypair used for local
 * signing.
 */
export function loadWalletKeypair(config: BotConfig): Keypair {
  const raw = config.wallet.privateKey.trim();
  if (!raw) {
    throw new Error(
      "WALLET_PRIVATE_KEY is empty. Create a dedicated hot wallet and set it in .env.",
    );
  }

  try {
    if (raw.startsWith("[")) {
      const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
      return Keypair.fromSecretKey(bytes);
    }
    const bytes = bs58.decode(raw);
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error(
      "WALLET_PRIVATE_KEY could not be parsed. Expected a base58 secret key " +
        "or a JSON byte array, and it must never be your main wallet's key.",
    );
  }
}
