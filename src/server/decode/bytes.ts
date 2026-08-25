import bs58 from "bs58";

/**
 * Coercions for values that arrive in more than one shape.
 *
 * JSON-RPC hands back base58 strings where the binary protocols hand back
 * bytes, and either can appear depending on how a transaction was fetched.
 * Normalising once here means nothing downstream has to guess.
 */

/** Raw pubkey bytes; the rest of the app wants base58. */
export function toBase58(value: Uint8Array | Buffer | string): string {
  return typeof value === "string" ? value : bs58.encode(value);
}

export function toBuffer(value: Uint8Array | Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "base64");
  return Buffer.from(value);
}
