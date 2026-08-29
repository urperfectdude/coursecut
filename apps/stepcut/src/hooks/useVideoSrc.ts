// Copied from apps/web/src/hooks/useVideoSrc.ts, pointed at this app's own
// `getPlaybackUrl` — apps/stepcut has no desktop counterpart, so there is no
// `convertFileSrc`-based local-path variant to stay compatible with, only
// the fetched-presigned-URL shape that reference already carries.

import { useEffect, useState } from "react";
import { getPlaybackUrl } from "@/api/videos";

/** Returns `undefined` until the URL arrives, because an empty-string `src`
 * makes the browser re-request the page itself. `storageKey` is empty before
 * its owning row has loaded — skip the request rather than minting a URL for
 * a key that doesn't exist yet. */
export function useVideoSrc(storageKey: string): string | undefined {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (storageKey === "") return;
    let cancelled = false;
    setSrc(undefined);
    getPlaybackUrl(storageKey)
      .then((url) => {
        if (!cancelled) setSrc(url || undefined);
      })
      .catch(() => {
        // Best-effort — a failed URL mint leaves the player empty rather
        // than taking the view down.
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  return src;
}
