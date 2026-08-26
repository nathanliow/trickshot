import { byokAllowed, readOnly } from "@/server/config";

import { HistoryReplay } from "@/components/HistoryReplay";
import { replayable } from "@/server/history";
import { siteLimit } from "@/server/budget";

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
        /**
         * Whether to offer BYOK at all. Read on the server because only the
         * server knows — a control that stores a key the API will then ignore
         * is worse than no control.
         */
        byok={byokAllowed()}
      />
    </div>
  );
}
