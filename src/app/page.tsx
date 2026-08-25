import { HistoryReplay } from "@/components/HistoryReplay";
import { siteLimit } from "@/server/budget";
import { readOnly } from "@/server/config";
import { replayable } from "@/server/history";

export const dynamic = "force-dynamic";

/**
 * The gallery is read on the server so it is in the first paint.
 *
 * Fetched from the client it arrived a round trip late, and the main content
 * of the home page visibly popped in after the form had already rendered.
 */
export default async function TrickshotPage() {
  /**
   * Both on the server, so a closed day is visible in the first paint.
   *
   * Fetched from the client the banner would appear a round trip after the
   * form it is warning about, which is long enough to type a wallet into it.
   */
  const [tokens, limit] = await Promise.all([replayable(), siteLimit()]);
  return (
    <div className="py-8 sm:py-12">
      <HistoryReplay
        initialTokens={tokens}
        readOnly={readOnly()}
        limited={limit !== null}
      />
    </div>
  );
}
