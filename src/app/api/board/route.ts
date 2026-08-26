import { NextResponse } from "next/server";
import { owner } from "@/server/config";
import { keyFrom, withKey } from "@/server/key";
import { traderBoard } from "@/server/history";

/**
 * Who made and lost the most on a token.
 *
 * Its own endpoint because it is slow for a reason that will not go away:
 * every wallet it ranks has its complete history on the mint read back, which
 * is the only way to put an honest number beside an address. MEASURED on a
 * 27-day token, the chart takes about six seconds and this takes eighty.
 *
 * Asking for both in one request meant a blank page for a minute and a half to
 * see a chart that had been ready the whole time. The page now draws the chart
 * as soon as it has it and calls this after.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  return withKey(keyFrom(request), () => handle(request));
}

async function handle(request: Request) {
  const params = new URL(request.url).searchParams;
  const mint = params.get("mint")?.trim() ?? "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return NextResponse.json({ error: "a valid mint is required" }, { status: 400 });
  }

  /**
   * Building a board is the owner's to spend, and asking is not enough.
   *
   * This endpoint used to be gated on the mint being indexed, which stopped
   * working the moment anything else could put a mint in the index: a chart
   * built on the request path leaves a row behind, and the board for that row
   * does not exist yet, so `traderBoard` would fall through to nomination and
   * read a couple of hundred wallets in full for whoever asked second.
   *
   * `update` is the same hazard with a shorter fuse — it SKIPS the cached fast
   * path outright, so it reaches the minutes-long branch however the build is
   * gated. The two travel together: no permission to build, no update.
   */
  /**
   * Still owner-only with a visitor's key. BYOK answers the money objection to
   * building a board, not the other one: ~80 seconds and two hundred wallets
   * inside one function, for something everyone then shares.
   *
   * The key is still used here to re-mark the cached board to spot.
   */
  const mayBuild = owner(request);

  try {
    const board = await traderBoard(mint, mayBuild && params.get("update") === "1", [], mayBuild);
    if (!board) {
      return NextResponse.json(
        { error: "the trader board for this token has not been worked out yet" },
        { status: 404 },
      );
    }
    return NextResponse.json(board);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
