import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import type { VideoProgress } from "../db";

/** Subscribes to Rust's "video-progress" channel (`src-tauri/src/
 * progress.rs`) for the lifetime of the component, keeping only the latest
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
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<VideoProgress>("video-progress", (event) => {
      setProgress((prev) => ({ ...prev, [event.payload.video_id]: event.payload }));
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Best-effort: a failed subscription just means no progress UI for
        // this session, not a reason to break the pipeline itself.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
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
