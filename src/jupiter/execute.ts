import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import type { SwapResponse } from "./types.js";

export interface ExecutedSwap {
  signature: string;
  confirmed: boolean;
}

/**
 * Signs a Jupiter-built swap transaction locally and submits it, resending
 * periodically until confirmed or the quote's last-valid block height is
 * exceeded. The private key never leaves this process.
 */
export async function signAndSendSwap(
  connection: Connection,
  keypair: Keypair,
  swap: SwapResponse,
  timeoutMs = 60_000,
): Promise<ExecutedSwap> {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(swap.swapTransaction, "base64"),
  );
  tx.sign([keypair]);
  const rawTx = tx.serialize();

  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    maxRetries: 0,
  });

  const deadline = Date.now() + timeoutMs;
  let lastResend = Date.now();

  while (Date.now() < deadline) {
    const { value: statuses } = await connection.getSignatureStatuses([
      signature,
    ]);
    const status = statuses[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return { signature, confirmed: status.err === null };
    }

    const blockHeight = await connection.getBlockHeight("confirmed");
    if (blockHeight > swap.lastValidBlockHeight) break;

    if (Date.now() - lastResend > 2_000) {
      lastResend = Date.now();
      await connection
        .sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 })
        .catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  return { signature, confirmed: false };
}
