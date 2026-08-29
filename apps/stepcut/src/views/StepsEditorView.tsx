// The step editor — Phase 4 (docs/stepcut-plan.md §8: "Manual editing").
// No coursecut counterpart: apps/stepcut's views are original, not ported
// from desktop. What's ported is the *interaction pattern* apps/web's lesson
// editor already established for `lessons.source` — draft-then-commit-on-
// blur for text, a numeric field per boundary, a busy-guard per row, and a
// shared confirm dialog before delete — same pattern, applied to a step's
// single `start`/`end` range instead of a lesson's segment list (steps have
// no `lesson_segments`-style child table; see `apps/stepcut-api/src/db/
// schema.ts`'s header). Any edit here flips a step's `source` to `"manual"`
// server-side (`apps/stepcut-api/src/domain/steps.ts`), which is what keeps
// it out of `analyze`'s replace-only-`'ai'`-rows pass on a re-run.
//
// Deliberately smaller than apps/web's `SourceVideoPreview`/
// `LessonPreviewPlayer` pair: a plain `<video controls>` (native scrubbing)
// stands in for a custom timeline, and "Split at current time" / "Use
// current time" buttons stand in for dragging a boundary — precise enough to
// prove the interaction, without porting a custom scrubber this phase
// doesn't need.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useVideoSrc } from "@/hooks/useVideoSrc";
import {
  addStep,
  deleteStep,
  getSteps,
  getVideo,
  splitStep,
  updateStep,
  type Step,
  type Video,
} from "@/api/videos";

interface StepsEditorViewProps {
  videoId: string;
  onBack: () => void;
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** How long a freshly added step spans by default — enough to see and
 * immediately adjust, not a guess at the real boundary. */
const NEW_STEP_SPAN_SECS = 5;

export default function StepsEditorView({ videoId, onBack }: StepsEditorViewProps) {
  const [video, setVideo] = useState<Video | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-step in-flight guard — same defensive pattern as apps/web's
  // `LessonEditorView`/`LessonSegmentsView`, so a rapid double click on one
  // row's Split/Delete/blur can't fire two concurrent mutations against it.
  const busyRef = useRef<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const [pendingDelete, setPendingDelete] = useState<Step | null>(null);
  const [adding, setAdding] = useState(false);

  // Draft values for title/summary, keyed by step id — same draft-then-
  // commit-on-blur pattern as apps/web's lesson editor. Absence from these
  // maps means "show the server value," same convention as that reference.
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [summaryDrafts, setSummaryDrafts] = useState<Record<string, string>>({});

  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const src = useVideoSrc(video?.storage_key ?? "");

  const setBusy = useCallback((id: string, busy: boolean) => {
    if (busy) busyRef.current.add(id);
    else busyRef.current.delete(id);
    setBusyIds(new Set(busyRef.current));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getVideo(videoId), getSteps(videoId)])
      .then(([videoRow, stepRows]) => {
        if (cancelled) return;
        setVideo(videoRow);
        setSteps(stepRows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  const refreshSteps = useCallback(async () => {
    setSteps(await getSteps(videoId));
  }, [videoId]);

  const sortedSteps = useMemo(() => [...steps].sort((a, b) => a.sort_order - b.sort_order), [steps]);

  const commitPatch = useCallback(
    async (step: Step, patch: { start?: number; end?: number; title?: string; summary?: string }) => {
      if (busyRef.current.has(step.id)) {
        setError("Still saving the previous change to this step — try again in a moment.");
        return;
      }
      setBusy(step.id, true);
      try {
        await updateStep(step.id, patch);
        await refreshSteps();
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(step.id, false);
      }
    },
    [refreshSteps, setBusy],
  );

  const commitTitle = useCallback(
    (step: Step) => {
      const draft = titleDrafts[step.id];
      setTitleDrafts((prev) => {
        if (!(step.id in prev)) return prev;
        const next = { ...prev };
        delete next[step.id];
        return next;
      });
      if (draft === undefined) return;
      const trimmed = draft.trim();
      if (trimmed === "" || trimmed === step.title) return;
      void commitPatch(step, { title: trimmed });
    },
    [titleDrafts, commitPatch],
  );

  const commitSummary = useCallback(
    (step: Step) => {
      const draft = summaryDrafts[step.id];
      setSummaryDrafts((prev) => {
        if (!(step.id in prev)) return prev;
        const next = { ...prev };
        delete next[step.id];
        return next;
      });
      if (draft === undefined) return;
      if (draft === (step.summary ?? "")) return;
      void commitPatch(step, { summary: draft });
    },
    [summaryDrafts, commitPatch],
  );

  const handleSetBoundToCurrentTime = useCallback(
    (step: Step, bound: "start" | "end") => {
      if (bound === "start" && !(currentTime < step.end)) {
        setError("Start must land before the step's end — change ignored.");
        return;
      }
      if (bound === "end" && !(currentTime > step.start)) {
        setError("End must land after the step's start — change ignored.");
        return;
      }
      void commitPatch(step, bound === "start" ? { start: currentTime } : { end: currentTime });
    },
    [currentTime, commitPatch],
  );

  const handleSplit = useCallback(
    async (step: Step) => {
      if (busyRef.current.has(step.id)) return;
      setBusy(step.id, true);
      try {
        await splitStep(step.id, currentTime);
        await refreshSteps();
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(step.id, false);
      }
    },
    [currentTime, refreshSteps, setBusy],
  );

  const handleConfirmDelete = useCallback(async () => {
    const step = pendingDelete;
    if (!step) return;
    setPendingDelete(null);
    setBusy(step.id, true);
    try {
      await deleteStep(step.id);
      await refreshSteps();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(step.id, false);
    }
  }, [pendingDelete, refreshSteps, setBusy]);

  const handleAddStep = useCallback(async () => {
    if (adding) return;
    setAdding(true);
    try {
      const start = currentTime;
      const end = video?.duration ? Math.min(start + NEW_STEP_SPAN_SECS, video.duration) : start + NEW_STEP_SPAN_SECS;
      if (!(start < end)) {
        setError("Can't add a step at the very end of the video — scrub back a little first.");
        return;
      }
      await addStep(videoId, { start, end, title: "New step" });
      await refreshSteps();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }, [adding, currentTime, video, videoId, refreshSteps]);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-4 flex items-center justify-between gap-4">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        {video && (
          <span className="truncate text-sm text-muted-foreground" title={video.storage_key}>
            {video.storage_key.split("/").pop()}
          </span>
        )}
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!loading && video && (
        <>
          <video
            ref={videoRef}
            src={src}
            controls
            className="mb-6 w-full rounded-lg bg-black"
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          />

          {sortedSteps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No steps yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {sortedSteps.map((step, index) => {
                const isBusy = busyIds.has(step.id);
                const canSplit = currentTime > step.start && currentTime < step.end;
                return (
                  <li key={step.id} className="rounded-lg border border-border p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{index + 1}.</span>
                      <Badge variant={step.source === "manual" ? "default" : "outline"}>
                        {step.source === "manual" ? "Manual" : "AI"}
                      </Badge>
                      <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
                        {formatTimestamp(step.start)}–{formatTimestamp(step.end)}
                      </span>
                    </div>

                    <Input
                      type="text"
                      value={titleDrafts[step.id] ?? step.title}
                      disabled={isBusy}
                      onChange={(event) =>
                        setTitleDrafts((prev) => ({ ...prev, [step.id]: event.target.value }))
                      }
                      onBlur={() => commitTitle(step)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      aria-label={`Title for step ${index + 1}`}
                      className="mb-2 font-medium"
                    />

                    <Textarea
                      value={summaryDrafts[step.id] ?? step.summary ?? ""}
                      disabled={isBusy}
                      onChange={(event) =>
                        setSummaryDrafts((prev) => ({ ...prev, [step.id]: event.target.value }))
                      }
                      onBlur={() => commitSummary(step)}
                      placeholder="Summary…"
                      rows={2}
                      aria-label={`Summary for step ${index + 1}`}
                      className="mb-2"
                    />

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => handleSetBoundToCurrentTime(step, "start")}
                      >
                        Set start to {formatTimestamp(currentTime)}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => handleSetBoundToCurrentTime(step, "end")}
                      >
                        Set end to {formatTimestamp(currentTime)}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canSplit || isBusy}
                        onClick={() => void handleSplit(step)}
                      >
                        Split at {formatTimestamp(currentTime)}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="ml-auto"
                        disabled={isBusy}
                        onClick={() => setPendingDelete(step)}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <Button type="button" variant="outline" className="mt-4" disabled={adding} onClick={() => void handleAddStep()}>
            {adding ? "Adding…" : `+ Add step at ${formatTimestamp(currentTime)}`}
          </Button>
        </>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete step?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete && `Delete step "${pendingDelete.title}"? This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleConfirmDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
