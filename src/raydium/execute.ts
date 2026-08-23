import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import type { RaydiumBuiltTransaction } from "./client.js";

export async function signAndSendRaydiumTransactions(
  connection: Connection,
  keypair: Keypair,
  transactions: readonly RaydiumBuiltTransaction[],
  timeoutMs = 45_000,
): Promise<string> {
  let lastSignature: string | undefined;

  for (const built of transactions) {
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(built.transaction, "base64"),
    );
    transaction.sign([keypair]);
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, maxRetries: 2 },
    );
    lastSignature = signature;
    const deadline = Date.now() + timeoutMs;
    let confirmed = false;
    while (Date.now() < deadline) {
      const status = (await connection.getSignatureStatuses([signature]))
        .value[0];
      if (status?.err) {
        throw new Error(
          `Raydium transaction failed: ${signature} ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        confirmed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!confirmed) {
      throw new Error(`Raydium transaction did not confirm: ${signature}`);
    }
  }

  if (!lastSignature) throw new Error("Raydium returned no transaction");
  return lastSignature;
}
