import { NextResponse } from "next/server";
import { usage } from "@/server/budget";
import { owner } from "@/server/config";
import { depth } from "@/server/queue";

/**
 * How much of today's budget has gone, and on what.
 *
 * Owner-only. The numbers are harmless in themselves, but they say exactly how
 * much room is left before the site stops building — which is the one thing
 * worth knowing if you intend to exhaust it.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!owner(request)) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }
  const [now, queued] = await Promise.all([usage(), depth()]);
  return NextResponse.json({ ...now, queue: { depth: queued } });
}
