import { NextResponse } from "next/server";
import { replayable } from "@/server/history";

/**
 * Tokens this install has already reconstructed.
 *
 * NOT a catalogue of what can be replayed — that is every mint on Solana, and
 * nothing here is indexed ahead of time. This is the far smaller and more
 * useful list: the ones already built, which redraw from cache in a couple of
 * seconds rather than reading windows across their whole life again.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ tokens: await replayable() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
