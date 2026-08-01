// PORTED FROM: src/hooks/useVideoProgress.ts @ 16d83e5
// DEVIATIONS: D4 — subscribes over SSE instead of Tauri's event channel.
// One-way port — desktop is upstream. Don't edit this for web-only reasons;
// port the change to the desktop file first. See docs/web-app-plan.md §7.1,
// and re-run scripts/ui-drift.sh (which reads the SHA above) after syncing.
import { useCallback, useEffect, useState } from "react";

import { subscribeProgress } from "../api";

import type { VideoProgress } from "../db";

/** Subscribes to the server's progress stream (`GET /api/progress`, plan
 * D4) for the lifetime of the component, keeping only the latest
 * event per `video_id` (last-write-wins — only the most recent progress
 * matters). Dumb by design: no formatting/labeling logic here, that belongs
 * to whatever renders `progress[videoId]`. This hook is meant to survive
 * into M3/M4 unchanged as the row-level UI around it is replaced. */
export function useVideoProgress(): {
  progress: Record<string, VideoProgress>;
  // Callers must clear a video's stale entry themselves right before
  // starting a new operation on it (extract/transcribe/analyze) — a cache
  // hit can resolve an operation without ever emitting a fresh event, and
  // without this, the previous operation's (possibly different-stage,
  // different-attempt) event would keep rendering for the whole duration.
  clearProgress: (videoId: string) => void;
} {
  const [progress, setProgress] = useState<Record<string, VideoProgress>>({});

  useEffect(() => {
    // Best-effort, as on desktop: EventSource reconnects on its own, and a
    // stream that never opens just means no progress UI for this session,
    // not a reason to break the pipeline itself.
    const unsubscribe = subscribeProgress<VideoProgress>((event) => {
      setProgress((prev) => ({ ...prev, [event.video_id]: event }));
    });
    return unsubscribe;
  }, []);

  const clearProgress = useCallback((videoId: string) => {
    setProgress((prev) => {
      if (!(videoId in prev)) return prev;
      const next = { ...prev };
      delete next[videoId];
      return next;
    });
  }, []);

  return { progress, clearProgress };
}
