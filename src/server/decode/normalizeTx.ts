import { toBase58, toBuffer } from "./bytes";

/**
 * Turn an archival transaction into one stable shape.
 *
 * This layer exists because the wire format is not friendly: the proto is
 * snake_case but the NAPI binding may hand back camelCase, pubkeys arrive as
 * raw bytes, and u64s arrive as number | string | bigint depending on
 * magnitude and codec. Normalising once here means nothing downstream has to
 * defend against any of it.
 */

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  /** The pool/user PDA that owns the token account — this is what lets us
   *  group a swap's two legs without a pre-resolved vault registry. */
  owner: string;
  amountRaw: bigint;
  decimals: number;
}

export interface InnerInstruction {
  programId: string;
  data: Buffer;
  stackHeight: number;
}

export interface NormalizedTx {
  signature: string;
  slot: number;
  /** Absent on some updates; the caller falls back to wall clock. */
  blockTime?: number;
  failed: boolean;
  /** Static keys first, then ALT writable, then ALT readonly — the order the
   *  runtime uses to resolve every instruction's programIdIndex. */
  accountKeys: string[];
  /** The leading `numRequiredSignatures` keys. Used to tell a user's own token
   *  accounts apart from pool vaults during balance-delta decoding. */
  signers: Set<string>;
  logs: string[];
  /**
   * Every program the transaction invoked, top level and inner.
   *
   * Inner instructions alone cannot tell a swap from a transfer: a pool called
   * directly has the DEX at the TOP level and nothing but token transfers
   * underneath it, so judging by inner programs alone reads it as plumbing.
   */
  programIds: string[];
  innerInstructions: InnerInstruction[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  preBalances: bigint[];
  postBalances: bigint[];
}

type Any = Record<string, unknown>;

function pick(source: unknown, ...names: string[]): unknown {
  if (!source || typeof source !== "object") return undefined;
  const obj = source as Any;
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null) return obj[name];
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value !== "") return BigInt(value);
  return 0n;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  return 0;
}

/**
 * Coerce a timestamp to unix seconds.
 *
 * `createdAt` can arrive as a Date, epoch millis, or a protobuf
 * `{ seconds, nanos }`. Feeding any of those to asNumber() yields either NaN
 * or a value ~1000x too large, which renders as a nonsense clock.
 */
function asUnixSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  let n: number;
  if (value instanceof Date) n = value.getTime() / 1000;
  else if (typeof value === "object" && "seconds" in (value as Any)) {
    n = asNumber((value as Any).seconds);
  } else if (typeof value === "string" && Number.isNaN(Number(value))) {
    n = Date.parse(value) / 1000;
  } else {
    n = asNumber(value);
  }

  if (!Number.isFinite(n) || n <= 0) return undefined;
  while (n > 1e11) n /= 1000; // millis, micros, nanos
  return Math.floor(n);
}

function normalizeTokenBalances(raw: unknown): TokenBalance[] {
  return asArray(raw).flatMap((entry) => {
    const mint = pick(entry, "mint");
    if (mint === undefined) return [];
    const ui = pick(entry, "uiTokenAmount", "ui_token_amount");
    return [
      {
        accountIndex: asNumber(pick(entry, "accountIndex", "account_index")),
        mint: toBase58(mint as never),
        owner: toBase58((pick(entry, "owner") ?? "") as never),
        amountRaw: asBigInt(pick(ui, "amount")),
        decimals: asNumber(pick(ui, "decimals")),
      },
    ];
  });
}

export function normalizeTx(update: unknown): NormalizedTx | null {
  const envelope = pick(update, "transaction");
  if (!envelope) return null;

  // The update nests a second time: { transaction: { transaction, meta } }.
  const inner = pick(envelope, "transaction") ?? envelope;
  const meta = pick(envelope, "meta") ?? pick(inner, "meta");
  if (!meta) return null;

  const message = pick(inner, "message") ?? pick(pick(inner, "transaction"), "message");
  if (!message) return null;

  const staticKeys = asArray(
    pick(message, "accountKeys", "account_keys"),
  ).map((k) => toBase58(k as never));
  const loadedWritable = asArray(
    pick(meta, "loadedWritableAddresses", "loaded_writable_addresses"),
  ).map((k) => toBase58(k as never));
  const loadedReadonly = asArray(
    pick(meta, "loadedReadonlyAddresses", "loaded_readonly_addresses"),
  ).map((k) => toBase58(k as never));

  const accountKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];

  const numSigners = asNumber(
    pick(pick(message, "header"), "numRequiredSignatures", "num_required_signatures"),
  );
  const signers = new Set(staticKeys.slice(0, Math.max(numSigners, 1)));

  const programIds = new Set<string>();
  for (const ix of asArray(pick(message, "instructions"))) {
    const id = accountKeys[asNumber(pick(ix, "programIdIndex", "program_id_index"))];
    if (id) programIds.add(id);
  }

  const innerInstructions: InnerInstruction[] = [];
  for (const group of asArray(
    pick(meta, "innerInstructions", "inner_instructions"),
  )) {
    for (const ix of asArray(pick(group, "instructions"))) {
      const index = asNumber(pick(ix, "programIdIndex", "program_id_index"));
      const programId = accountKeys[index];
      if (!programId) continue;
      programIds.add(programId);
      innerInstructions.push({
        programId,
        data: toBuffer((pick(ix, "data") ?? Buffer.alloc(0)) as never),
        stackHeight: asNumber(pick(ix, "stackHeight", "stack_height")),
      });
    }
  }

  // MEASURED shape: update.transaction = { transaction: {...}, slot } and the
  // signature sits on that nested object, not on the outer envelope:
  //   inner keys = signature, isVote, transaction, meta, index
  // Checking the envelope first silently yields an empty signature, which
  // breaks every Solscan link downstream.
  const signatureRaw =
    pick(inner, "signature") ??
    pick(envelope, "signature") ??
    asArray(pick(inner, "signatures"))[0];

  // Transaction updates carry no block time; `createdAt` is the stream's
  // receive timestamp, which is far closer than the consumer's wall clock.
  const blockTimeRaw =
    pick(update, "blockTime", "block_time") ?? pick(update, "createdAt");

  return {
    signature: signatureRaw ? toBase58(signatureRaw as never) : "",
    slot: asNumber(pick(envelope, "slot") ?? pick(update, "slot")),
    blockTime: asUnixSeconds(blockTimeRaw),
    failed: pick(meta, "err") != null,
    accountKeys,
    programIds: [...programIds],
    signers,
    logs: asArray(pick(meta, "logMessages", "log_messages")).map(String),
    innerInstructions,
    preTokenBalances: normalizeTokenBalances(
      pick(meta, "preTokenBalances", "pre_token_balances"),
    ),
    postTokenBalances: normalizeTokenBalances(
      pick(meta, "postTokenBalances", "post_token_balances"),
    ),
    preBalances: asArray(pick(meta, "preBalances", "pre_balances")).map(asBigInt),
    postBalances: asArray(pick(meta, "postBalances", "post_balances")).map(asBigInt),
  };
}
