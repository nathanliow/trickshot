import { isProgramDerived } from "./address";
import { config } from "./config";
import { take } from "./limit";
import { chargeRpc } from "./meter";
import type { NormalizedTx } from "./decode/normalizeTx";
import { identify } from "./identity";
import { WSOL_MINT } from "./mints";

/**
 * The other wallets one wallet is operating with.
 *
 * A trader's position is often split: one wallet buys, another holds, a third
 * cashes out. Read alone, each shows a fraction of the story and none of them
 * shows the profit. This finds the direct counterparties of a subject wallet
 * and says which of them look like the same operation.
 *
 * Everything here is INFERENCE and is presented as such. Funding, timing and
 * exclusivity make a strong case and are not proof of common ownership, so
 * nothing is merged into the subject's PnL unless the reader asks for it.
 *
 * Two counterparties look identical to a naive transfer graph and are not
 * wallets at all:
 *
 *   ephemeral       a temporary wrapped-SOL account, created, funded and
 *                   closed inside one transaction. It can carry thousands of
 *                   SOL and belongs to the subject itself. Zero lamports and
 *                   no data afterwards is the tell.
 *
 *   infrastructure  an exchange hot wallet, a relayer, a router's fee payer.
 *                   Real, busy, and nothing to do with the operation. Helius
 *                   names most of them, which beats guessing from size.
 */

/** Native SOL below this is fee noise, not a transfer worth following. */
const SOL_DUST = 0.05;
/** Pages of the subject's non-mint history read to find funding legs. */
const CONTEXT_PAGES = Number(process.env.GRAPH_CONTEXT_PAGES ?? 4);
/** Counterparties probed. Ranked by what moved before the cut. */
const PROBE_LIMIT = Number(process.env.GRAPH_PROBE_LIMIT ?? 24);
/**
 * A counterparty that pays out to this many wallets at once is distributing,
 * not partnering. MEASURED on this token: the address that looked like a
 * nine-transfer relationship was fanning dust to twenty wallets a transaction.
 */
const FANOUT = Number(process.env.GRAPH_FANOUT ?? 5);
/**
 * How much of the subject's own trading a counterparty has to account for
 * before the relationship means anything. A wallet that once sent 572 tokens
 * to someone holding five million has told you nothing.
 */
const MATERIAL = Number(process.env.GRAPH_MATERIAL ?? 0.02);
/** Or this much SOL, for counterparties that never touched the token. */
const MATERIAL_SOL = Number(process.env.GRAPH_MATERIAL_SOL ?? 5);

export type LinkKind = "linked" | "infrastructure" | "ephemeral" | "incidental";

export interface Related {
  wallet: string;
  /** From Helius, when it knows the address. */
  name?: string;
  category?: string;
  kind: LinkKind;
  /** Plain sentences a reader can check. */
  why: string[];
  /** Base tokens moved between this wallet and the subject, by transfer. */
  tokensFromSubject: number;
  tokensToSubject: number;
  /** Native SOL moved, either way. */
  solFromSubject: number;
  solToSubject: number;
  transfers: number;
}

export interface WalletGraph {
  mint: string;
  wallet: string;
  /** Worth folding into the subject's PnL, if the reader agrees. */
  linked: Related[];
  /** Shown so the reader can see what was ruled out, and why. */
  dismissed: Related[];
  builtAt: number;
}

async function rpc<T>(method: string, params: unknown): Promise<T | null> {
  try {
    await take();
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "graph", method, params }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: T };
    chargeRpc(method, params, body.result);
    return body.result ?? null;
  } catch {
    return null;
  }
}

interface Edge {
  tokensFromSubject: number;
  tokensToSubject: number;
  solFromSubject: number;
  solToSubject: number;
  transfers: number;
  /** Most wallets this counterparty moved the token to in one transaction. */
  fanout: number;
}

function edge(edges: Map<string, Edge>, who: string): Edge {
  let held = edges.get(who);
  if (!held) {
    held = {
      tokensFromSubject: 0,
      tokensToSubject: 0,
      solFromSubject: 0,
      solToSubject: 0,
      transfers: 0,
      fanout: 0,
    };
    edges.set(who, held);
  }
  return held;
}

/**
 * Who the token went to, and came from, when no pool was involved.
 *
 * Reads the transactions already fetched for the wallet's own fills, so it
 * costs nothing. Swaps are skipped deliberately: the counterparty of a swap is
 * a pool, and a pool is not a wallet.
 */
function tokenEdges(
  txs: NormalizedTx[],
  mint: string,
  wallet: string,
  edges: Map<string, Edge>,
): number {
  /**
   * The largest position the wallet ever held, which is what a transfer should
   * be judged against. Summing every delta instead counts each token twice —
   * once in, once out — and counts trades as well as transfers, so a genuine
   * 224,804-token transfer scored 1.95% of a wallet holding 5.5M and was
   * dismissed as dust.
   */
  let position = 0;
  let peak = 0;
  for (const tx of txs) {
    if (tx.failed) continue;

    let subject = 0;
    const others: { owner: string; delta: number }[] = [];
    for (const after of tx.postTokenBalances) {
      if (after.mint !== mint || !after.owner) continue;
      const before = tx.preTokenBalances.find(
        (b) => b.accountIndex === after.accountIndex,
      );
      const delta =
        Number(after.amountRaw - (before?.amountRaw ?? 0n)) / 10 ** after.decimals;
      if (delta === 0) continue;
      if (after.owner === wallet) subject += delta;
      else others.push({ owner: after.owner, delta });
    }
    position += subject;
    peak = Math.max(peak, position);
    if (subject === 0) continue;

    // A pool on the other side means this was a trade, not a transfer.
    if (others.some((o) => isProgramDerived(o.owner))) continue;

    /**
     * How many wallets this transaction paid at once. One payer sending to
     * twenty addresses is an airdrop; the subject is just one of the twenty,
     * and the payer is not its partner.
     */
    const recipients = others.filter(
      (o) => Math.sign(o.delta) === Math.sign(subject),
    ).length;

    for (const other of others) {
      // Only the side that moved opposite the subject is a counterparty.
      if (Math.sign(other.delta) === Math.sign(subject)) continue;
      const e = edge(edges, other.owner);
      if (subject < 0) e.tokensFromSubject += Math.abs(subject);
      else e.tokensToSubject += Math.abs(subject);
      e.transfers += 1;
      e.fanout = Math.max(e.fanout, recipients + 1);
    }
  }
  return peak;
}

/**
 * Who the SOL went to, and came from.
 *
 * The return leg of a split operation is usually native SOL and usually does
 * not touch the token at all, so this reads a bounded slice of the wallet's
 * other history rather than only its mint transactions. Bounded by the window
 * the wallet was actually trading in, because funding that predates the token
 * by months says nothing about this trade.
 */
function solEdges(
  txs: NormalizedTx[],
  wallet: string,
  edges: Map<string, Edge>,
): void {
  for (const tx of txs) {
    if (tx.failed) continue;
    const index = tx.accountKeys.indexOf(wallet);
    if (index < 0) continue;

    const subject =
      Number((tx.postBalances[index] ?? 0n) - (tx.preBalances[index] ?? 0n)) / 1e9;
    if (Math.abs(subject) < SOL_DUST) continue;

    // The largest opposite move in the same transaction is the counterparty.
    let best: { owner: string; delta: number } | null = null;
    tx.accountKeys.forEach((key, i) => {
      if (i === index || !key || isProgramDerived(key)) return;
      const delta =
        Number((tx.postBalances[i] ?? 0n) - (tx.preBalances[i] ?? 0n)) / 1e9;
      if (Math.abs(delta) < SOL_DUST) return;
      if (Math.sign(delta) === Math.sign(subject)) return;
      if (!best || Math.abs(delta) > Math.abs(best.delta)) {
        best = { owner: key, delta };
      }
    });
    if (!best) continue;

    const found = best as { owner: string; delta: number };
    const e = edge(edges, found.owner);
    if (subject < 0) e.solFromSubject += Math.abs(subject);
    else e.solToSubject += Math.abs(subject);
    e.transfers += 1;
  }
}

/** The wallet's other activity over the window it was trading this token in. */
async function contextTransactions(
  wallet: string,
  from: number,
  to: number,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let token: string | undefined;
  for (let page = 0; page < CONTEXT_PAGES; page += 1) {
    const res = await rpc<{ data?: unknown[]; paginationToken?: string }>(
      "getTransactionsForAddress",
      [
        wallet,
        {
          transactionDetails: "full",
          sortOrder: "asc",
          limit: 1_000,
          maxSupportedTransactionVersion: 0,
          filters: { status: "succeeded", blockTime: { gte: from, lt: to } },
          ...(token ? { paginationToken: token } : {}),
        },
      ],
    );
    const data = res?.data ?? [];
    out.push(...data);
    token = res?.paginationToken;
    if (!token || data.length === 0) break;
  }
  return out;
}

/**
 * Decide what each counterparty actually is.
 *
 * Three questions, all cheap, and the order matters: an address that does not
 * exist cannot be a wallet however much moved through it, and a named exchange
 * is a terminal node however much it looks like a partner.
 */
async function classify(
  candidates: { wallet: string; edge: Edge }[],
  /** The subject's peak holding, the yardstick for "did this matter". */
  peak: number,
): Promise<Related[]> {
  const addresses = candidates.map((c) => c.wallet);
  const [accounts, names] = await Promise.all([
    rpc<{ value?: ({ lamports?: number; data?: unknown } | null)[] }>(
      "getMultipleAccounts",
      [addresses, { encoding: "base64" }],
    ),
    identify(addresses),
  ]);

  return candidates.map((c, i) => {
    const account = accounts?.value?.[i];
    const known = names.get(c.wallet);
    const why: string[] = [];
    const tokens = c.edge.tokensFromSubject + c.edge.tokensToSubject;
    const sol = c.edge.solFromSubject + c.edge.solToSubject;

    if (c.edge.tokensFromSubject > 0) {
      why.push(
        `received ${round(c.edge.tokensFromSubject)} tokens from this wallet`,
      );
    }
    if (c.edge.tokensToSubject > 0) {
      why.push(`sent ${round(c.edge.tokensToSubject)} tokens to this wallet`);
    }
    if (c.edge.solFromSubject > 0) {
      why.push(`received ${c.edge.solFromSubject.toFixed(1)} SOL from this wallet`);
    }
    if (c.edge.solToSubject > 0) {
      why.push(`sent ${c.edge.solToSubject.toFixed(1)} SOL to this wallet`);
    }
    why.push(`${c.edge.transfers} transfers between them`);

    let kind: LinkKind = "linked";
    /**
     * A zero-lamport account with no data is not a wallet at all — it is a
     * temporary wrapped-SOL account the subject itself opened and closed. One
     * of these can carry thousands of SOL and would otherwise be reported as
     * the operation's largest partner.
     */
    if (!account || ((account.lamports ?? 0) === 0 && !account.data)) {
      kind = "ephemeral";
      why.unshift("account does not exist — a temporary account, not a wallet");
    } else if (known?.name) {
      kind = "infrastructure";
      why.unshift(`known address: ${known.name}${known.category ? ` (${known.category})` : ""}`);
    } else if (c.edge.fanout >= FANOUT) {
      kind = "infrastructure";
      why.unshift(
        `pays out to ${c.edge.fanout} wallets at a time — a distribution, not a partner`,
      );
    } else if (
      tokens < peak * MATERIAL &&
      sol < MATERIAL_SOL &&
      c.edge.transfers < 5
    ) {
      /**
       * Too small to mean anything. Kept and shown rather than hidden, because
       * "someone sent this wallet dust once" is a useful thing to be able to
       * see and a terrible thing to fold into a PnL.
       */
      kind = "incidental";
      why.unshift(
        tokens > 0
          ? `only ${round(tokens)} tokens moved — ${((tokens / Math.max(peak, 1)) * 100).toFixed(2)}% of this wallet's peak holding`
          : `only ${sol.toFixed(2)} SOL moved`,
      );
    }

    return {
      wallet: c.wallet,
      name: known?.name,
      category: known?.category,
      kind,
      why,
      ...c.edge,
    };
  });
}

function round(v: number): string {
  return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
}

/**
 * One ring out from a wallet: who it moved this token or real money with.
 *
 * Deliberately one ring. Walking outward finds deeper structure and compounds
 * its mistakes — a wrong link in the first ring drags in everything behind it,
 * and there is no way for a reader to tell which hop went wrong.
 */
export async function walletGraph(
  mint: string,
  wallet: string,
  mintTxs: NormalizedTx[],
  window: { from: number; to: number },
  adapt: (raw: unknown) => NormalizedTx | null,
): Promise<WalletGraph> {
  const edges = new Map<string, Edge>();
  const peak = tokenEdges(mintTxs, mint, wallet, edges);

  const context = await contextTransactions(wallet, window.from, window.to);
  const decoded: NormalizedTx[] = [];
  for (const raw of context) {
    const tx = adapt(raw);
    if (tx) decoded.push(tx);
  }
  solEdges(decoded, wallet, edges);

  edges.delete(wallet);
  edges.delete(WSOL_MINT);

  /**
   * Ranked by what actually moved, so the cut falls on the noise. Tokens and
   * SOL are not comparable, so each is scored against the largest of its kind
   * rather than added together.
   */
  const all = [...edges.entries()].map(([w, e]) => ({ wallet: w, edge: e }));
  const topTokens = Math.max(
    ...all.map((c) => c.edge.tokensFromSubject + c.edge.tokensToSubject),
    1,
  );
  const topSol = Math.max(
    ...all.map((c) => c.edge.solFromSubject + c.edge.solToSubject),
    1,
  );
  const weight = (c: (typeof all)[number]) =>
    (c.edge.tokensFromSubject + c.edge.tokensToSubject) / topTokens +
    (c.edge.solFromSubject + c.edge.solToSubject) / topSol;

  const candidates = all.sort((a, b) => weight(b) - weight(a)).slice(0, PROBE_LIMIT);
  if (candidates.length === 0) {
    return { mint, wallet, linked: [], dismissed: [], builtAt: 0 };
  }

  const classified = await classify(candidates, peak);
  return {
    mint,
    wallet,
    linked: classified.filter((r) => r.kind === "linked"),
    dismissed: classified.filter((r) => r.kind !== "linked"),
    builtAt: 0,
  };
}
