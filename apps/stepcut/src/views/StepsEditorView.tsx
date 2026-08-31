// The step editor — Phase 4 (docs/stepcut-plan.md §8: "Manual editing"),
// extended with direct timestamp editing, a per-step preview clip, and a
// free-text AI edit (Phase 6). No coursecut counterpart: apps/stepcut's
// views are original, not ported from desktop. What's ported is the
// *interaction pattern* apps/web's lesson editor already established for
// `lessons.source` — draft-then-commit-on-blur for text and for the
// start/end timestamp fields, a busy-guard per row, a shared confirm dialog
// before delete, and (for the AI edit) a propose-then-review-then-apply
// dialog. Any edit here flips a step's `source` to `"manual"` server-side
// (`apps/stepcut-api/src/domain/steps.ts`), which is what keeps it out of
// `analyze`'s replace-only-`'ai'`-rows pass on a re-run.
//
// Still deliberately smaller than apps/web's `SourceVideoPreview`/
// `LessonPreviewPlayer` pair for the *whole-recording* player: a plain
// `<video controls>` (native scrubbing) stands in for a custom timeline —
// precise enough to prove the interaction, without porting a custom
// scrubber this phase doesn't need. `StepClipPlayer` (per-row) is its own,
// smaller bespoke transport, for a different reason: a step's few-second
// clip needs a scrubber scaled to *it*, not to the full recording, which
// native controls can't do (see that component's header).

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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronUp } from "lucide-react";
import RenderPanel from "@/components/RenderPanel";
import StepClipPlayer from "@/components/StepClipPlayer";
import { useVideoSrc } from "@/hooks/useVideoSrc";
import { formatTimestamp, formatTimestampMs, parseTimestampMs } from "@/lib/timestamp";
import {
  addStep,
  applyStepsEdit,
  deleteStep,
  getSteps,
  getVideo,
  previewStepsEdit,
  splitStep,
  updateStep,
  type Step,
  type StepEdit,
  type Video,
} from "@/api/videos";

interface StepsEditorViewProps {
  projectId: string;
  videoId: string;
  onBack: () => void;
}

/** How long a freshly added step spans by default — enough to see and
 * immediately adjust, not a guess at the real boundary. */
const NEW_STEP_SPAN_SECS = 5;

/** Step size for the Start/End fields' ▲/▼ nudge buttons — matches
 * `formatTimestampMs`'s millisecond precision. */
const BOUND_STEP_SECONDS = 0.01;

/** Short example instructions the floating AI input cycles through as its
 * placeholder while empty. */
const AI_INSTRUCTION_PLACEHOLDERS = [
  "Merge the last two steps",
  "Split step 2 at 1:20",
  "Remove the step about opening settings",
  "Make the titles shorter",
];

export default function StepsEditorView({ projectId, videoId, onBack }: StepsEditorViewProps) {
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

  // Draft values for the per-step start/end hh:mm:ss:fff fields, same
  // pattern — replaces the old "Set start/end to current time" buttons with
  // a field the boundary can be typed into directly.
  const [startDrafts, setStartDrafts] = useState<Record<string, string>>({});
  const [endDrafts, setEndDrafts] = useState<Record<string, string>>({});

  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const src = useVideoSrc(video?.storage_key ?? "");

  // Free-text AI edit (Phase 6) — the floating prompt box below and its
  // old-vs-new review dialog. `proposedSteps` non-null means the dialog is
  // open; `aiPreviewBusy` covers both the main box's initial preview and the
  // dialog's own "Update proposal" refine (same call shape), `aiApplyBusy`
  // is separate so the dialog's buttons can disable independently of the
  // outer prompt box.
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiPreviewBusy, setAiPreviewBusy] = useState(false);
  const [aiApplyBusy, setAiApplyBusy] = useState(false);
  const [proposedSteps, setProposedSteps] = useState<StepEdit[] | null>(null);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [aiPlaceholderIndex, setAiPlaceholderIndex] = useState(0);

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

  const commitStart = useCallback(
    (step: Step) => {
      const draft = startDrafts[step.id];
      setStartDrafts((prev) => {
        if (!(step.id in prev)) return prev;
        const next = { ...prev };
        delete next[step.id];
        return next;
      });
      if (draft === undefined) return;
      const parsed = parseTimestampMs(draft);
      if (parsed === null) {
        setError("Start must be in hh:mm:ss:fff format.");
        return;
      }
      if (!(parsed < step.end)) {
        setError("Start must be less than end — change ignored.");
        return;
      }
      void commitPatch(step, { start: parsed });
    },
    [startDrafts, commitPatch],
  );

  const commitEnd = useCallback(
    (step: Step) => {
      const draft = endDrafts[step.id];
      setEndDrafts((prev) => {
        if (!(step.id in prev)) return prev;
        const next = { ...prev };
        delete next[step.id];
        return next;
      });
      if (draft === undefined) return;
      const parsed = parseTimestampMs(draft);
      if (parsed === null) {
        setError("End must be in hh:mm:ss:fff format.");
        return;
      }
      if (!(parsed > step.start)) {
        setError("End must be greater than start — change ignored.");
        return;
      }
      void commitPatch(step, { end: parsed });
    },
    [endDrafts, commitPatch],
  );

  // Nudges one bound of `step` by ±`BOUND_STEP_SECONDS`, committing
  // immediately (no draft/blur step, unlike typing into the field).
  // Silently no-ops if the nudge would push start past end or below zero,
  // same "change ignored" spirit the typed-field path uses without needing
  // a banner for what's obviously just the button being at its limit.
  const adjustBound = useCallback(
    (step: Step, bound: "start" | "end", direction: 1 | -1) => {
      if (busyRef.current.has(step.id)) return;
      const delta = direction * BOUND_STEP_SECONDS;
      const nextStart = bound === "start" ? step.start + delta : step.start;
      const nextEnd = bound === "end" ? step.end + delta : step.end;
      if (nextStart < 0 || !(nextStart < nextEnd)) return;
      void commitPatch(step, bound === "start" ? { start: nextStart } : { end: nextEnd });
    },
    [commitPatch],
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

  // Submits the outer prompt box: always starts from the video's real,
  // current steps (no baseline), never anything left over from a cancelled
  // dialog. Doesn't touch `steps` state either way — only opens the dialog
  // on success.
  const handlePreviewEdit = useCallback(async () => {
    if (aiPreviewBusy || aiInstruction.trim() === "") return;
    setAiPreviewBusy(true);
    try {
      const proposal = await previewStepsEdit(videoId, aiInstruction);
      setProposedSteps(proposal);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiPreviewBusy(false);
    }
  }, [aiPreviewBusy, aiInstruction, videoId]);

  useEffect(() => {
    if (aiInstruction !== "") return;
    const interval = setInterval(() => {
      setAiPlaceholderIndex((index) => (index + 1) % AI_INSTRUCTION_PLACEHOLDERS.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [aiInstruction]);

  // The dialog's "Update proposal": iterates on the *current* proposal
  // (passed as `baseline`), not the video's real steps.
  const handleRefineProposal = useCallback(async () => {
    if (aiPreviewBusy || proposedSteps === null || refineInstruction.trim() === "") return;
    setAiPreviewBusy(true);
    try {
      const proposal = await previewStepsEdit(videoId, refineInstruction, proposedSteps);
      setProposedSteps(proposal);
      setRefineInstruction("");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiPreviewBusy(false);
    }
  }, [aiPreviewBusy, proposedSteps, refineInstruction, videoId]);

  const handleApplyProposal = useCallback(async () => {
    if (aiApplyBusy || proposedSteps === null) return;
    setAiApplyBusy(true);
    try {
      await applyStepsEdit(videoId, proposedSteps);
      await refreshSteps();
      setProposedSteps(null);
      setRefineInstruction("");
      setAiInstruction("");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiApplyBusy(false);
    }
  }, [aiApplyBusy, proposedSteps, videoId, refreshSteps]);

  const handleCancelProposal = useCallback(() => {
    setProposedSteps(null);
    setRefineInstruction("");
  }, []);

  return (
    <div className="mx-auto max-w-3xl p-8 pb-32">
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

                    <StepClipPlayer src={src} start={step.start} end={step.end} />

                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <label className="flex flex-col gap-0.5 text-xs">
                        Start
                        <div className="relative">
                          <Input
                            type="text"
                            inputMode="numeric"
                            pattern="\d+:[0-5]?\d:[0-5]?\d:\d{3}"
                            placeholder="hh:mm:ss:fff"
                            disabled={isBusy}
                            value={startDrafts[step.id] ?? formatTimestampMs(step.start)}
                            onChange={(event) =>
                              setStartDrafts((prev) => ({ ...prev, [step.id]: event.target.value }))
                            }
                            onBlur={() => commitStart(step)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                            aria-label={`Start time for step ${index + 1}`}
                            className="h-7 w-32 pr-5 font-mono text-xs tabular-nums"
                          />
                          <div className="absolute inset-y-0 right-0.5 flex flex-col justify-center">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={isBusy}
                              onClick={() => adjustBound(step, "start", 1)}
                              aria-label={`Increase start time for step ${index + 1}`}
                              className="h-3 w-4 [&_svg]:size-2.5"
                            >
                              <ChevronUp />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={isBusy}
                              onClick={() => adjustBound(step, "start", -1)}
                              aria-label={`Decrease start time for step ${index + 1}`}
                              className="h-3 w-4 [&_svg]:size-2.5"
                            >
                              <ChevronDown />
                            </Button>
                          </div>
                        </div>
                      </label>
                      <label className="flex flex-col gap-0.5 text-xs">
                        End
                        <div className="relative">
                          <Input
                            type="text"
                            inputMode="numeric"
                            pattern="\d+:[0-5]?\d:[0-5]?\d:\d{3}"
                            placeholder="hh:mm:ss:fff"
                            disabled={isBusy}
                            value={endDrafts[step.id] ?? formatTimestampMs(step.end)}
                            onChange={(event) =>
                              setEndDrafts((prev) => ({ ...prev, [step.id]: event.target.value }))
                            }
                            onBlur={() => commitEnd(step)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                            aria-label={`End time for step ${index + 1}`}
                            className="h-7 w-32 pr-5 font-mono text-xs tabular-nums"
                          />
                          <div className="absolute inset-y-0 right-0.5 flex flex-col justify-center">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={isBusy}
                              onClick={() => adjustBound(step, "end", 1)}
                              aria-label={`Increase end time for step ${index + 1}`}
                              className="h-3 w-4 [&_svg]:size-2.5"
                            >
                              <ChevronUp />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={isBusy}
                              onClick={() => adjustBound(step, "end", -1)}
                              aria-label={`Decrease end time for step ${index + 1}`}
                              className="h-3 w-4 [&_svg]:size-2.5"
                            >
                              <ChevronDown />
                            </Button>
                          </div>
                        </div>
                      </label>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canSplit || isBusy}
                        onClick={() => void handleSplit(step)}
                      >
                        Split at playhead
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

          {/* Rendering only makes sense once there's something to cut —
              gated on `sortedSteps` the same way the backend itself refuses
              a stepless render (`domain/renders.ts`'s `createRender`). */}
          {sortedSteps.length > 0 && <RenderPanel projectId={projectId} videoId={videoId} />}
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

      {proposedSteps !== null && (
        <StepsAiEditReviewDialog
          currentSteps={sortedSteps}
          proposedSteps={proposedSteps}
          refineInstruction={refineInstruction}
          onRefineInstructionChange={setRefineInstruction}
          onRefine={() => void handleRefineProposal()}
          onApply={() => void handleApplyProposal()}
          onCancel={handleCancelProposal}
          previewBusy={aiPreviewBusy}
          applyBusy={aiApplyBusy}
        />
      )}

      {!loading && video && (
        <div className="fixed inset-x-0 bottom-6 z-20 flex justify-center px-4">
          <div className="relative w-full max-w-xl rounded-3xl border border-border bg-background/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <Textarea
              value={aiInstruction}
              disabled={aiPreviewBusy}
              onChange={(event) => setAiInstruction(event.target.value)}
              placeholder={AI_INSTRUCTION_PLACEHOLDERS[aiPlaceholderIndex]}
              className="min-h-9 resize-none rounded-none border-none bg-transparent py-3 pl-4 pr-36 shadow-none focus-visible:border-none focus-visible:ring-0 dark:bg-transparent dark:disabled:bg-transparent"
              rows={1}
              aria-label="Describe a change to this video's steps"
            />
            <Button
              type="button"
              size="sm"
              className="absolute bottom-2 right-2 shrink-0 rounded-full"
              disabled={aiPreviewBusy || aiInstruction.trim() === ""}
              onClick={() => void handlePreviewEdit()}
            >
              {aiPreviewBusy && proposedSteps === null ? "Previewing…" : "Preview Changes"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface StepsAiEditReviewDialogProps {
  currentSteps: Step[];
  proposedSteps: StepEdit[];
  refineInstruction: string;
  onRefineInstructionChange: (value: string) => void;
  onRefine: () => void;
  onApply: () => void;
  onCancel: () => void;
  previewBusy: boolean;
  applyBusy: boolean;
}

/** Old-vs-new review dialog for the AI step edit prompt — opened whenever
 * `proposedSteps` is non-null. Always diffs against `currentSteps` (the
 * video's real, current rows), never against whatever the proposal looked
 * like before the last refine, so the review always reads as "real steps
 * today" vs. "what would land if Apply is clicked now." */
function StepsAiEditReviewDialog({
  currentSteps,
  proposedSteps,
  refineInstruction,
  onRefineInstructionChange,
  onRefine,
  onApply,
  onCancel,
  previewBusy,
  applyBusy,
}: StepsAiEditReviewDialogProps) {
  const isEmptyProposal = proposedSteps.length === 0;
  const busy = previewBusy || applyBusy;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="flex max-h-[80vh] flex-col sm:max-w-xl"
        aria-label="Review proposed step changes"
      >
        <DialogHeader>
          <DialogTitle>Review proposed changes</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {isEmptyProposal ? (
            <p className="text-sm text-muted-foreground">This would remove every step from this video.</p>
          ) : (
            <>
              <p className="text-sm font-semibold">Current steps</p>
              <ul className="m-0 flex max-h-[25vh] list-none flex-col gap-1 overflow-y-auto p-0">
                {currentSteps.map((step) => (
                  <li
                    key={step.id}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm"
                  >
                    <span className="truncate">{step.title}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {formatTimestamp(step.start)}–{formatTimestamp(step.end)}
                    </span>
                  </li>
                ))}
                {currentSteps.length === 0 && <li className="text-sm text-muted-foreground">(no steps)</li>}
              </ul>

              <p className="text-sm font-semibold">Proposed steps</p>
              <ul className="m-0 flex max-h-[25vh] list-none flex-col gap-1 overflow-y-auto p-0">
                {proposedSteps.map((step, index) => (
                  <li
                    key={`proposed-${index}`}
                    className="flex items-center justify-between gap-2 rounded-md border-l-2 border-emerald-400/70 bg-emerald-400/10 px-2 py-1 text-sm"
                  >
                    <span className="truncate">{step.title}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {formatTimestamp(step.start)}–{formatTimestamp(step.end)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="steps-ai-refine">Refine this proposal</Label>
            <Textarea
              id="steps-ai-refine"
              value={refineInstruction}
              disabled={busy}
              onChange={(event) => onRefineInstructionChange(event.target.value)}
              placeholder="e.g. &quot;keep the summaries shorter&quot;"
              rows={2}
              aria-label="Refine the proposed step changes"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Exact timestamps (<code>m:ss</code>, <code>h:mm:ss</code>) in your instruction are
            honored precisely.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy || refineInstruction.trim() === ""}
            onClick={onRefine}
          >
            {previewBusy ? "Updating…" : "Update proposal"}
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={applyBusy}>
            Cancel
          </Button>
          <Button type="button" onClick={onApply} disabled={busy}>
            {applyBusy ? "Applying…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
