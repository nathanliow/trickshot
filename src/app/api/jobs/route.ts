import { NextResponse } from "next/server";
import { depth, statusOf } from "@/server/queue";

/**
 * Where a token is in the indexing queue.
 *
 * Its own endpoint because it is the one thing a waiting page needs to ask
 * repeatedly, and it must stay cheap enough to poll: no chain reads, no
 * builds, one look at the queue. Everything expensive happens in the worker.
 */
export const dynamic = "force-dynamic";

const isAddress = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

export async function GET(request: Request) {
  const mint = new URL(request.url).searchParams.get("mint")?.trim() ?? "";
  if (mint && !isAddress(mint)) {
    return NextResponse.json({ error: "a valid mint is required" }, { status: 400 });
  }

  if (!mint) return NextResponse.json({ depth: await depth() });

  const held = await statusOf(mint);
  if (!held) {
    // Not queued is a normal answer, not a miss: the caller is asking whether
    // it needs to keep waiting, and "no" is the good outcome.
    return NextResponse.json({ mint, status: "none" });
  }
  return NextResponse.json({
    mint,
    status: held.job.status,
    ahead: held.ahead,
    requests: held.job.requests,
    buildSeconds: held.job.seconds,
    error: held.job.error,
  });
}
