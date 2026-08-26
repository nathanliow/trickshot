import { NextResponse } from "next/server";
import { hasKey, NoKey, owner, readOnly } from "@/server/config";
import { keyFrom, withKey } from "@/server/key";
import { identify, tokenIdentity } from "@/server/identity";
import { tokenRow } from "@/server/store";
import { buildsLeft, callerIp, siteLimit } from "@/server/budget";
import { withCaller } from "@/server/meter";
import { queued } from "@/server/queue";
import { tradedOnMany } from "@/server/history";
import { tradedMints } from "@/server/wallet";

/**
 * The tokens a wallet has traded, so people can find themselves.
 *
 * The site was built mint-first: you find a token, then you find who won on
 * it. That is the wrong way round for the thing most people actually want,
 * which is their own trades — and nobody has a mint to hand for that.
 *
 * Deliberately does NOT build anything. Enumerating is a handful of cheap
 * pages; drawing a chart for each of these would be one build per row, which
 * is why the rows say whether they are ready and the replay is a click away
 * rather than something this endpoint does on your behalf.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isAddress = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

/**
 * Rows returned, and how many of them get a name.
 *
 * A wallet with five hundred traded mints is a page nobody reads and a fan-out
 * nobody should pay for. Naming costs ten credits a mint, so the rest resolve
 * when they are clicked — which is also when anyone cares what they are.
 */
const MAX_ROWS = Number(process.env.WALLET_MAX_ROWS ?? 50);
const MAX_ENRICH = Number(process.env.WALLET_MAX_ENRICH ?? 10);

export async function GET(request: Request) {
  // Billed to the caller, and spent on their key when they brought one.
  return withKey(keyFrom(request), () =>
    withCaller(callerIp(request), () => handle(request)),
  );
}

async function handle(request: Request) {
  const params = new URL(request.url).searchParams;
  const wallet = params.get("address")?.trim() ?? "";
  if (!isAddress(wallet)) {
    return NextResponse.json({ error: "a valid wallet address is required" }, { status: 400 });
  }

  const pages = Number(params.get("pages") ?? 0) || undefined;
  /** Airdrops are hidden by default; `?spam=1` shows the whole tail. */
  const withSpam = params.get("spam") === "1";

  // Enumeration is cheap but not free: a DAS call per page and a probe per row.
  if (!hasKey()) {
    return NextResponse.json(
      {
        error: "this site has no Helius key of its own — add yours to look up a wallet",
        needsKey: true,
      },
      { status: 428 },
    );
  }

  try {
    const { mints, truncated, scanned } = await tradedMints(wallet, { pages });
    const candidates = (withSpam ? mints : mints.filter((m) => !m.likelySpam)).slice(
      0,
      MAX_ROWS,
    );

    /**
     * Holding is not trading, so ask before offering a replay.
     *
     * The enumeration reads token ACCOUNTS, which cannot tell a position the
     * owner built from one somebody sent them — a token held with no buy and no
     * sell replays as an empty chart, and offering it also offers to spend a
     * build on nothing. Ten credits a row to find out, in parallel, and only
     * for the rows about to be shown.
     *
     * Skipped entirely with `?spam=1`: that view exists to show everything that
     * was filtered, so filtering it again would defeat it.
     */
    let shown = candidates;
    if (!withSpam) {
      const traded = await tradedOnMany(
        candidates.map((m) => ({ mint: m.mint, wallet })),
      );
      shown = candidates.filter((m) => traded.get(m.mint));
    }

    /**
     * Rows the site already knows about answer for free.
     *
     * `coverage` matters as much as the name here: `full` means the token page
     * works, `window` means someone has replayed one wallet on it and nothing
     * more. Both are replayable; only one belongs in the gallery.
     */
    const known = await Promise.all(shown.map((m) => tokenRow(m.mint)));

    /**
     * Which of these are already being indexed.
     *
     * One read of the queue for the whole page, not one per row. Without it a
     * token somebody queued a minute ago still reads "not indexed yet", so they
     * queue it again — and the only thing that saves them from paying twice is
     * the dedup they cannot see.
     */
    const queue = await queued(shown.map((m) => m.mint));

    /**
     * Almost nothing needs naming any more.
     *
     * The enumeration itself carries name, symbol and image — that came free
     * with reading token accounts instead of transfers — so this is only for
     * the rare asset DAS returned without metadata. Capped anyway, and skipped
     * entirely on a read-only instance, where ten credits a row would label
     * mints it cannot replay.
     */
    const unknown = shown
      .map((m, i) => (known[i] || m.symbol || m.name ? null : m.mint))
      .filter((m): m is string => m !== null)
      .slice(0, readOnly() && !owner(request) ? 0 : MAX_ENRICH);
    const named = new Map(
      await Promise.all(
        unknown.map(async (mint) => [mint, await tokenIdentity(mint)] as const),
      ),
    );

    /**
     * The wallet's own name is looked up ONCE, here.
     *
     * Not once per row. The lookup is a hundred credits per REQUEST however
     * many addresses it carries, so asking per token would make a page of
     * fifty rows cost five thousand credits to label one wallet.
     */
    const name = (await identify([wallet])).get(wallet)?.name;

    return NextResponse.json({
      wallet,
      name,
      /**
       * Told up front, not on refusal.
       *
       * Every row that is not indexed costs a build to open, and a visitor
       * with one left should know that before they spend it on the wrong
       * token rather than after.
       */
      builds: await buildsLeft(callerIp(request)),
      /**
       * Whether anything on this page can still be BUILT today.
       *
       * Enumerating is not building and keeps working either way, so this
       * page still answers "what did I trade" when the day is spent. It has
       * to say so, though — every unindexed row here is a click that will be
       * refused, and letting somebody find that out one row at a time is the
       * version of this that reads as the site being broken.
       */
      limited: (await siteLimit()) !== null,
      /** Token accounts looked at, and how many were set aside. */
      scanned,
      /** Airdrops by the price/balance heuristic, plus anything never traded. */
      hidden: mints.length - shown.length,
      truncated,
      tokens: shown.map((m, i) => {
        const row = known[i];
        const extra = named.get(m.mint);
        return {
          mint: m.mint,
          name: row?.name ?? m.name ?? extra?.name,
          symbol: row?.symbol ?? m.symbol ?? extra?.symbol,
          image: row?.image ?? m.image ?? extra?.image,
          balance: m.balance,
          decimals: m.decimals,
          valueUsd: m.valueUsd,
          held: m.balance > 0,
          likelySpam: m.likelySpam,
          /** Whether anything has been built for it, and how much. */
          indexed: row !== null,
          coverage: row ? (row.coverage ?? "full") : null,
          /** "queued" or "building" when the worker already has it. */
          job: queue.get(m.mint) ?? null,
        };
      }),
    });
  } catch (error) {
    if (error instanceof NoKey) {
      return NextResponse.json(
        {
          error: "this site has no Helius key of its own — add yours to look up a wallet",
          needsKey: true,
        },
        { status: 428 },
      );
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
