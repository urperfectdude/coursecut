import { useEffect, useState } from "react";

import { getPlaybackUrl } from "../db";

/** D2: desktop derives a playback URL synchronously from a local path with
 * `convertFileSrc`. Here it has to be fetched — the API mints a short-TTL
 * presigned GET for the object — so the components that used to inline that
 * call use this instead.
 *
 * Returns `undefined` until the URL arrives, because an empty-string `src`
 * makes the browser re-request the page itself. No desktop counterpart, so
 * `ui-drift.sh` never compares it against anything. */
export function useVideoSrc(storageKey: string): string | undefined {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setSrc(undefined);
    getPlaybackUrl(storageKey)
      .then((url) => {
        if (!cancelled) setSrc(url || undefined);
      })
      .catch(() => {
        // Best-effort, same stance as the progress subscription: a failed
        // URL mint leaves the player empty rather than taking the view down.
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  return src;
}
