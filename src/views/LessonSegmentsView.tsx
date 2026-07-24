import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Breadcrumbs from "../components/Breadcrumbs";
import LessonPreviewPlayer from "../components/LessonPreviewPlayer";
import SourceVideoPreview from "../components/SourceVideoPreview";
import { basename } from "./ProjectDetailView";
import {
  addLessonSegment,
  applyLessonSegmentEdit,
  deleteLessonSegment,
  getProject,
  getVideo,
  listLessonSegments,
  listLessons,
  previewLessonSegmentEdit,
  queueExport,
  reorderLessonSegments,
  splitLesson,
  updateLesson,
  updateLessonSegment,
  type Lesson,
  type LessonSegment,
  type LessonSegmentRange,
  type Project,
  type Video,
} from "../db";

/** Seconds → `m:ss` / `h:mm:ss` — duplicated per-file rather than shared,
 * same convention as `LessonCard`'s and `SourceVideoPreview`'s own copies. */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${m}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : mmss;
}

/** Seconds → editable `hh:mm:ss:fff` — the single format for the per-segment
 * start/end fields (replaces the old read-only `h:mm:ss` hint plus separate
 * plain-seconds numeric input). */
function formatTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(ms).padStart(3, "0")}`;
}

/** Inverse of `formatTimestamp` — strict `hh:mm:ss:fff` only (always what the
 * field itself displays), so there's no ambiguity over how many digits a
 * partial millisecond count would mean. Returns `null` on anything else. */
function parseTimestamp(input: string): number | null {
  const match = /^(\d+):([0-5]?\d):([0-5]?\d):(\d{3})$/.exec(input.trim());
  if (!match) return null;
  const [, hh, mm, ss, fff] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(fff) / 1000;
}

/** Floating-point tolerance for comparing a proposed range against a current
 * one — segment bounds round-trip through JSON/the AI response, so an exact
 * `===` would flag a segment the model echoed back unchanged as "trimmed"
 * over a rounding fraction of a second. */
const RANGE_MATCH_EPSILON_SECS = 0.01;

function rangesApproximatelyEqual(a: LessonSegmentRange, b: LessonSegmentRange): boolean {
  return (
    Math.abs(a.start - b.start) < RANGE_MATCH_EPSILON_SECS &&
    Math.abs(a.end - b.end) < RANGE_MATCH_EPSILON_SECS
  );
}

function rangesOverlap(a: LessonSegmentRange, b: LessonSegmentRange): boolean {
  return a.start < b.end && b.start < a.end;
}

type SegmentDiffKind = "unchanged" | "trimmed" | "new";

interface SegmentDiffRow extends LessonSegmentRange {
  kind: SegmentDiffKind;
}

/** A first-cut, straightforward interval comparison between `current` (the
 * lesson's real segments, always the left side of the diff — never the
 * pre-refine proposal) and `proposed` (what would land if Apply is
 * clicked): each proposed range is exact-match "unchanged", overlapping-
 * but-different-bounds "trimmed", or no-overlap-with-anything-current
 * "new"; each current range with no overlap in `proposed` is "removed". Not
 * a full diff algorithm — see `docs/lesson-ai-edit-plan.md`. */
function diffProposedSegments(
  current: LessonSegmentRange[],
  proposed: LessonSegmentRange[],
): { proposedRows: SegmentDiffRow[]; removed: LessonSegmentRange[] } {
  const proposedRows = proposed.map((range) => {
    let kind: SegmentDiffKind = "new";
    if (current.some((existing) => rangesApproximatelyEqual(existing, range))) {
      kind = "unchanged";
    } else if (current.some((existing) => rangesOverlap(existing, range))) {
      kind = "trimmed";
    }
    return { ...range, kind };
  });
  const removed = current.filter(
    (existing) =>
      !proposed.some(
        (range) => rangesApproximatelyEqual(existing, range) || rangesOverlap(existing, range),
      ),
  );
  return { proposedRows, removed };
}

interface LessonSegmentsViewProps {
  projectId: string;
  videoId: string;
  lessonId: string;
  onNavigateHome: () => void;
  onNavigateProject: () => void;
  onNavigateTranscript: () => void;
  // Also this stage's "go back" affordance (via the "Lessons" breadcrumb) —
  // and where a segment delete that takes the whole lesson down with it
  // sends the user, since there's nothing left here to edit.
  onNavigateLessons: () => void;
}

/** A single lesson's own segment-editing page — split out of `LessonCard`
 * (see the conversation that led here) because expanding that editing UI
 * inline in the lesson grid meant breaking the card out to the full grid
 * row width, which read as broken/ugly. This page is a fresh mount per
 * visit (no state shared with the grid view), so every mutation here just
 * refetches this lesson's own segments locally — nothing needs to reach
 * back into `LessonEditorView`'s state. */
export default function LessonSegmentsView({
  projectId,
  videoId,
  lessonId,
  onNavigateHome,
  onNavigateProject,
  onNavigateTranscript,
  onNavigateLessons,
}: LessonSegmentsViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [video, setVideo] = useState<Video | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [segments, setSegments] = useState<LessonSegment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);

  // The lesson's summary is only editable here now (not on the grid
  // tile) — same draft-then-commit-on-blur pattern used for the segment
  // start/end fields below, just a single field rather than one per row.
  const [summaryDraft, setSummaryDraft] = useState<string | undefined>(undefined);
  const [summaryBusy, setSummaryBusy] = useState(false);

  // Real (source-file) current time, mirrored up from `LessonPreviewPlayer`
  // — used for "at playhead" trim/split, which operate on the real time,
  // not that component's own virtual stitched-timeline one.
  const [currentTime, setCurrentTime] = useState(0);

  // Draft values for the per-segment start/end numeric inputs, keyed by
  // segment id — same draft-then-commit-on-blur pattern as the summary
  // field above (and the lesson title on the grid tile).
  const [startDrafts, setStartDrafts] = useState<Record<string, string>>({});
  const [endDrafts, setEndDrafts] = useState<Record<string, string>>({});

  // Per-segment in-flight guard, same defensive pattern as
  // `LessonEditorView`'s busy-id sets.
  const [segmentBusyIds, setSegmentBusyIds] = useState<Set<string>>(new Set());

  // Queuing this lesson's own export — same folder-picker-then-queue flow
  // as `LessonEditorView`'s per-lesson Export button; viewing/managing the
  // queue itself (progress, pause/resume/cancel/retry) lives entirely in
  // `ExportHistoryView`.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Per-lesson AI segment edit (`docs/lesson-ai-edit-plan.md`) — the free-
  // text prompt box below and its old-vs-new review popup. `proposedSegments`
  // non-null means the popup is open; `aiPreviewBusy` covers both the main
  // box's initial preview and the popup's "Update proposal" refine (same
  // call shape), `aiApplyBusy` is separate so the popup's own buttons can
  // disable independently of the outer prompt box.
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiPreviewBusy, setAiPreviewBusy] = useState(false);
  const [aiApplyBusy, setAiApplyBusy] = useState(false);
  const [proposedSegments, setProposedSegments] = useState<LessonSegmentRange[] | null>(null);
  const [refineInstruction, setRefineInstruction] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getProject(projectId), getVideo(videoId), listLessons(videoId)])
      .then(([projectRow, videoRow, lessonRows]) => {
        if (cancelled) return;
        setProject(projectRow);
        setVideo(videoRow);
        setLesson(lessonRows.find((row) => row.id === lessonId) ?? null);
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
  }, [projectId, videoId, lessonId]);

  const fetchSegments = useCallback(async () => {
    setSegmentsLoading(true);
    setSegmentsError(null);
    try {
      setSegments(await listLessonSegments(lessonId));
    } catch (err) {
      setSegmentsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSegmentsLoading(false);
    }
  }, [lessonId]);

  useEffect(() => {
    void fetchSegments();
  }, [fetchSegments]);

  // Submits the outer prompt box: always starts from this lesson's real,
  // current DB segments (no `baseline`), never anything left over from a
  // cancelled popup. Doesn't touch `segments` state either way — only opens
  // the popup on success.
  const handlePreviewEdit = useCallback(async () => {
    if (aiPreviewBusy || aiInstruction.trim() === "") return;
    setAiPreviewBusy(true);
    try {
      const proposal = await previewLessonSegmentEdit(lessonId, aiInstruction);
      setProposedSegments(proposal);
      setSegmentsError(null);
    } catch (err) {
      setSegmentsError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiPreviewBusy(false);
    }
  }, [aiPreviewBusy, aiInstruction, lessonId]);

  // The popup's "Update proposal": iterates on the *current* proposal
  // (passed as `baseline`), not the lesson's real DB rows.
  const handleRefineProposal = useCallback(async () => {
    if (aiPreviewBusy || proposedSegments === null || refineInstruction.trim() === "") return;
    setAiPreviewBusy(true);
    try {
      const proposal = await previewLessonSegmentEdit(lessonId, refineInstruction, proposedSegments);
      setProposedSegments(proposal);
      setRefineInstruction("");
      setSegmentsError(null);
    } catch (err) {
      setSegmentsError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiPreviewBusy(false);
    }
  }, [aiPreviewBusy, proposedSegments, refineInstruction, lessonId]);

  const handleApplyProposal = useCallback(async () => {
    if (aiApplyBusy || proposedSegments === null || proposedSegments.length === 0) return;
    setAiApplyBusy(true);
    try {
      await applyLessonSegmentEdit(lessonId, proposedSegments);
      setProposedSegments(null);
      setRefineInstruction("");
      setAiInstruction("");
      await fetchSegments();
      setSegmentsError(null);
    } catch (err) {
      setSegmentsError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiApplyBusy(false);
    }
  }, [aiApplyBusy, proposedSegments, lessonId, fetchSegments]);

  // No calls, `segments` untouched — the outer instruction textarea is left
  // as-is so the user can tweak wording and resubmit (which always goes
  // through the no-`baseline` path above, so it never inherits this).
  const handleCancelProposal = useCallback(() => {
    setProposedSegments(null);
    setRefineInstruction("");
  }, []);

  const commitSummary = useCallback(async () => {
    if (!lesson || summaryBusy) return;
    if (summaryDraft === undefined) return;
    const trimmed = summaryDraft.trim();
    setSummaryDraft(undefined);
    if (trimmed === (lesson.summary ?? "")) return;
    setSummaryBusy(true);
    try {
      setLesson(await updateLesson(lesson.id, { summary: trimmed }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSummaryBusy(false);
    }
  }, [lesson, summaryDraft, summaryBusy]);

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExportError(null);
    try {
      const dir = await open({ directory: true });
      if (!dir || typeof dir !== "string") return;
      setExporting(true);
      await queueExport([lessonId], dir);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [exporting, lessonId]);

  const commitSegmentStart = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) {
        setSegmentsError("Still saving the previous change — try again in a moment.");
        return;
      }
      const draft = startDrafts[segment.id];
      setStartDrafts((prev) => {
        if (!(segment.id in prev)) return prev;
        const next = { ...prev };
        delete next[segment.id];
        return next;
      });
      if (draft === undefined) return;
      const parsed = parseTimestamp(draft);
      if (parsed === null) {
        setSegmentsError("Start must be in hh:mm:ss:fff format.");
        return;
      }
      if (!(parsed < segment.end)) {
        setSegmentsError("Start must be less than end — change ignored.");
        return;
      }
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        await updateLessonSegment(segment.id, parsed, segment.end);
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [startDrafts, segmentBusyIds, fetchSegments],
  );

  const commitSegmentEnd = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) {
        setSegmentsError("Still saving the previous change — try again in a moment.");
        return;
      }
      const draft = endDrafts[segment.id];
      setEndDrafts((prev) => {
        if (!(segment.id in prev)) return prev;
        const next = { ...prev };
        delete next[segment.id];
        return next;
      });
      if (draft === undefined) return;
      const parsed = parseTimestamp(draft);
      if (parsed === null) {
        setSegmentsError("End must be in hh:mm:ss:fff format.");
        return;
      }
      if (!(parsed > segment.start)) {
        setSegmentsError("End must be greater than start — change ignored.");
        return;
      }
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        await updateLessonSegment(segment.id, segment.start, parsed);
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [endDrafts, segmentBusyIds, fetchSegments],
  );

  const handleTrimSegmentStart = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) return;
      if (!(currentTime < segment.end)) {
        setSegmentsError("Trim Start must land before the segment's end — change ignored.");
        return;
      }
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        await updateLessonSegment(segment.id, currentTime, segment.end);
        await fetchSegments();
        setStartDrafts((prev) => {
          if (!(segment.id in prev)) return prev;
          const next = { ...prev };
          delete next[segment.id];
          return next;
        });
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [currentTime, segmentBusyIds, fetchSegments],
  );

  const handleTrimSegmentEnd = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) return;
      if (!(currentTime > segment.start)) {
        setSegmentsError("Trim End must land after the segment's start — change ignored.");
        return;
      }
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        await updateLessonSegment(segment.id, segment.start, currentTime);
        await fetchSegments();
        setEndDrafts((prev) => {
          if (!(segment.id in prev)) return prev;
          const next = { ...prev };
          delete next[segment.id];
          return next;
        });
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [currentTime, segmentBusyIds, fetchSegments],
  );

  const handleDeleteSegment = useCallback(
    async (segment: LessonSegment) => {
      if (segmentBusyIds.has(segment.id)) return;
      if (!window.confirm("Delete this segment? This cannot be undone.")) return;
      setSegmentBusyIds((prev) => new Set(prev).add(segment.id));
      try {
        const result = await deleteLessonSegment(segment.id);
        if (result.lesson_deleted) {
          // The lesson itself no longer exists — nothing left to edit here.
          onNavigateLessons();
          return;
        }
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [segmentBusyIds, fetchSegments, onNavigateLessons],
  );

  // Swaps `segments[index]` with its neighbor at `index + direction` (-1 =
  // up/earlier, +1 = down/later) — playback order only, doesn't touch any
  // segment's own start/end. Busy-guards on both ids involved, same
  // in-flight-guard convention as the other segment mutations here.
  const handleMoveSegment = useCallback(
    async (index: number, direction: -1 | 1) => {
      const other = index + direction;
      if (other < 0 || other >= segments.length) return;
      const a = segments[index];
      const b = segments[other];
      if (segmentBusyIds.has(a.id) || segmentBusyIds.has(b.id)) return;
      setSegmentBusyIds((prev) => new Set(prev).add(a.id).add(b.id));
      try {
        const reordered = [...segments];
        reordered[index] = b;
        reordered[other] = a;
        await reorderLessonSegments(
          lessonId,
          reordered.map((segment) => segment.id),
        );
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(a.id);
          next.delete(b.id);
          return next;
        });
      }
    },
    [segments, segmentBusyIds, lessonId, fetchSegments],
  );

  const handleSplitSegment = useCallback(
    async (segment: LessonSegment) => {
      try {
        await splitLesson(lessonId, segment.id, currentTime);
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
      }
    },
    [lessonId, currentTime, fetchSegments],
  );

  // Adds a new segment `[start, end)` to this lesson from the side-by-side
  // `SourceVideoPreview`'s Mark In/Out controls — this page only ever has
  // one lesson to target (unlike `LessonEditorView`'s multi-lesson
  // selection), so `hasSelectedLesson` is always true and there's no
  // selection state to thread through. Rethrows on failure so
  // `SourceVideoPreview` leaves the user's marks in place to retry, same
  // contract as `LessonEditorView`'s own `handleAddSegment`.
  const handleAddSourceSegment = useCallback(
    async (start: number, end: number) => {
      try {
        await addLessonSegment(lessonId, start, end);
        await fetchSegments();
        setSegmentsError(null);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [lessonId, fetchSegments],
  );

  // Cumulative virtual-timeline duration *before* each segment, same
  // stitched-together-timeline math as `LessonPreviewPlayer`'s own
  // `segmentOffsets` (kept separate rather than shared since that one also
  // tracks the active-playback index, which isn't relevant here) — this is
  // what lets the read-only "final video" columns below show each
  // segment's position in the exported lesson rather than the source file.
  const segmentOffsets = useMemo(() => {
    let acc = 0;
    return segments.map((segment) => {
      const offset = acc;
      acc += segment.end - segment.start;
      return offset;
    });
  }, [segments]);

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { label: "Projects", onClick: onNavigateHome },
          ...(project ? [{ label: project.name, onClick: onNavigateProject }] : []),
          ...(video ? [{ label: basename(video.file_path), onClick: onNavigateTranscript }] : []),
          { label: "Lessons", onClick: onNavigateLessons },
          { label: lesson?.title ?? "Lesson" },
        ]}
      />

      {loading && <p>Loading lesson…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && (!video || !lesson) && (
        <p>
          Lesson not found —{" "}
          <button type="button" className="link-button" onClick={onNavigateLessons}>
            back to lessons
          </button>
          .
        </p>
      )}

      {video && lesson && (
        <>
          <div className="project-header">
            <h1>{lesson.title}</h1>
            <div className="project-header-actions">
              <button
                type="button"
                className="export-history-button"
                disabled={exporting}
                onClick={() => void handleExport()}
              >
                {exporting ? "Queuing export…" : "Export"}
              </button>
            </div>
          </div>
          {exportError && <p className="error">{exportError}</p>}
          <textarea
            className="lesson-summary-input lesson-segments-summary"
            value={summaryDraft ?? lesson.summary ?? ""}
            disabled={summaryBusy}
            onChange={(event) => setSummaryDraft(event.target.value)}
            onBlur={() => void commitSummary()}
            placeholder="Summary…"
            rows={3}
            aria-label={`Summary for lesson ${lesson.title}`}
          />
          <p className="lesson-item-time">
            {formatDuration(lesson.start)}–{formatDuration(lesson.end)}
          </p>

          <div className="lesson-segments-ai-panel">
            <textarea
              className="lesson-segments-ai-textarea"
              value={aiInstruction}
              disabled={aiPreviewBusy}
              onChange={(event) => setAiInstruction(event.target.value)}
              placeholder="Describe the change — e.g. &quot;cut the part about pricing&quot; or &quot;split at 12:30&quot; or &quot;trim everything after 4:15&quot;"
              rows={2}
              aria-label="Describe a change to this lesson's segments"
            />
            <p className="lesson-segments-ai-hint">
              Exact timestamps (<code>m:ss</code>, <code>h:mm:ss</code>) in your instruction are
              honored precisely.
            </p>
            <button
              type="button"
              disabled={aiPreviewBusy || aiInstruction.trim() === ""}
              onClick={() => void handlePreviewEdit()}
            >
              {aiPreviewBusy && proposedSegments === null ? "Previewing…" : "Preview changes"}
            </button>
          </div>

          <div className="lesson-segments-preview-row">
            {/* The raw source video, alongside the lesson's own stitched
               preview — lets the user scrub the full original recording to
               find a boundary without leaving this page, rather than only
               being able to play back what's already in the lesson. Shares
               `currentTime` (via `onTimeUpdate`) with the lesson preview, so
               either player's playhead drives Trim/Split at playhead below;
               its own segment-highlight overlay shows where this lesson's
               segments sit in the full recording, and its Mark In/Out feeds
               `handleAddSourceSegment` to add new ones. Placed first (left)
               since it's the input the lesson preview (right) is derived
               from — the arrow between them reads that direction. */}
            <div className="lesson-segments-source-preview">
              <p className="lesson-segments-preview-label">Original video</p>
              <SourceVideoPreview
                filePath={video.file_path}
                selectedLessonSegments={segments}
                hasSelectedLesson
                onTimeUpdate={setCurrentTime}
                onAddSegment={handleAddSourceSegment}
              />
            </div>

            <span className="lesson-segments-preview-arrow" aria-hidden="true">
              »
            </span>

            <div className="lesson-card-preview lesson-segments-preview">
              <p className="lesson-segments-preview-label">Final video</p>
              <LessonPreviewPlayer
                videoFilePath={video.file_path}
                segments={segments}
                lessonTitle={lesson.title}
                onTimeUpdate={setCurrentTime}
              />
              {segmentsLoading && <p>Loading segments…</p>}
              {segmentsError && <p className="error">{segmentsError}</p>}
            </div>
          </div>

          <ul className="lesson-card-segment-list">
            {segments.map((segment, index) => {
              const isSegmentBusy = segmentBusyIds.has(segment.id);
              const canSplitSegment = currentTime > segment.start && currentTime < segment.end;
              return (
                <li key={segment.id} className="lesson-card-segment-row">
                  <div className="lesson-card-segment-order">
                    <span className="lesson-card-segment-order-index">{index + 1}</span>
                    <button
                      type="button"
                      disabled={isSegmentBusy || index === 0}
                      onClick={() => void handleMoveSegment(index, -1)}
                      aria-label="Move segment earlier"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      disabled={isSegmentBusy || index === segments.length - 1}
                      onClick={() => void handleMoveSegment(index, 1)}
                      aria-label="Move segment later"
                    >
                      ▼
                    </button>
                  </div>
                  <label className="lesson-card-segment-field">
                    Start
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="\d+:[0-5]?\d:[0-5]?\d:\d{3}"
                      placeholder="hh:mm:ss:fff"
                      disabled={isSegmentBusy}
                      value={startDrafts[segment.id] ?? formatTimestamp(segment.start)}
                      onChange={(event) =>
                        setStartDrafts((prev) => ({ ...prev, [segment.id]: event.target.value }))
                      }
                      onBlur={() => void commitSegmentStart(segment)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      aria-label={`Start time for segment ${segment.id}`}
                    />
                  </label>
                  <label className="lesson-card-segment-field">
                    End
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="\d+:[0-5]?\d:[0-5]?\d:\d{3}"
                      placeholder="hh:mm:ss:fff"
                      disabled={isSegmentBusy}
                      value={endDrafts[segment.id] ?? formatTimestamp(segment.end)}
                      onChange={(event) =>
                        setEndDrafts((prev) => ({ ...prev, [segment.id]: event.target.value }))
                      }
                      onBlur={() => void commitSegmentEnd(segment)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      aria-label={`End time for segment ${segment.id}`}
                    />
                  </label>
                  <span className="lesson-card-segment-field lesson-card-segment-field-readonly">
                    Final video start
                    <span aria-label={`Final video start time for segment ${segment.id}`}>
                      {formatTimestamp(segmentOffsets[index])}
                    </span>
                  </span>
                  <span className="lesson-card-segment-field lesson-card-segment-field-readonly">
                    Final video end
                    <span aria-label={`Final video end time for segment ${segment.id}`}>
                      {formatTimestamp(segmentOffsets[index] + (segment.end - segment.start))}
                    </span>
                  </span>
                  <div className="lesson-card-segment-actions">
                    <button
                      type="button"
                      disabled={isSegmentBusy}
                      onClick={() => void handleTrimSegmentStart(segment)}
                    >
                      Trim Start
                    </button>
                    <button
                      type="button"
                      disabled={isSegmentBusy}
                      onClick={() => void handleTrimSegmentEnd(segment)}
                    >
                      Trim End
                    </button>
                    <button
                      type="button"
                      disabled={!canSplitSegment || isSegmentBusy}
                      onClick={() => void handleSplitSegment(segment)}
                    >
                      Split at playhead
                    </button>
                    <button
                      type="button"
                      className="delete-button"
                      disabled={isSegmentBusy}
                      onClick={() => void handleDeleteSegment(segment)}
                    >
                      Delete segment
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {proposedSegments !== null && (
            <LessonAiEditReviewModal
              currentSegments={segments}
              proposedSegments={proposedSegments}
              refineInstruction={refineInstruction}
              onRefineInstructionChange={setRefineInstruction}
              onRefine={() => void handleRefineProposal()}
              onApply={() => void handleApplyProposal()}
              onCancel={handleCancelProposal}
              previewBusy={aiPreviewBusy}
              applyBusy={aiApplyBusy}
            />
          )}
        </>
      )}
    </div>
  );
}

interface LessonAiEditReviewModalProps {
  currentSegments: LessonSegmentRange[];
  proposedSegments: LessonSegmentRange[];
  refineInstruction: string;
  onRefineInstructionChange: (value: string) => void;
  onRefine: () => void;
  onApply: () => void;
  onCancel: () => void;
  previewBusy: boolean;
  applyBusy: boolean;
}

/** Old-vs-new review popup for the AI segment edit prompt
 * (`docs/lesson-ai-edit-plan.md`) — opened by `LessonSegmentsView` whenever
 * `proposedSegments` is non-null. Always diffs against `currentSegments`
 * (the lesson's real, current rows), never against whatever the proposal
 * looked like before the last refine, so the review always reads as "real
 * lesson today" vs. "what would land if Apply is clicked now." */
function LessonAiEditReviewModal({
  currentSegments,
  proposedSegments,
  refineInstruction,
  onRefineInstructionChange,
  onRefine,
  onApply,
  onCancel,
  previewBusy,
  applyBusy,
}: LessonAiEditReviewModalProps) {
  const { proposedRows, removed } = useMemo(
    () => diffProposedSegments(currentSegments, proposedSegments),
    [currentSegments, proposedSegments],
  );
  const isEmptyProposal = proposedSegments.length === 0;
  const busy = previewBusy || applyBusy;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-panel lesson-segments-ai-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Review proposed segment changes"
      >
        <h2>Review proposed changes</h2>

        {isEmptyProposal ? (
          <p>This would remove every segment in this lesson.</p>
        ) : (
          <>
            <p className="lesson-segments-ai-diff-heading">Current segments</p>
            <ul className="lesson-segments-ai-diff-list">
              {currentSegments.map((segment, index) => (
                <li key={`current-${index}`} className="lesson-segments-ai-diff-row">
                  {formatTimestamp(segment.start)}–{formatTimestamp(segment.end)}
                </li>
              ))}
              {currentSegments.length === 0 && <li>(no segments)</li>}
            </ul>

            <p className="lesson-segments-ai-diff-heading">Proposed segments</p>
            <ul className="lesson-segments-ai-diff-list">
              {proposedRows.map((row, index) => (
                <li
                  key={`proposed-${index}`}
                  className={`lesson-segments-ai-diff-row lesson-segments-ai-diff-${row.kind}`}
                >
                  {formatTimestamp(row.start)}–{formatTimestamp(row.end)}
                  <span className="lesson-segments-ai-diff-badge">{row.kind}</span>
                </li>
              ))}
              {removed.map((segment, index) => (
                <li
                  key={`removed-${index}`}
                  className="lesson-segments-ai-diff-row lesson-segments-ai-diff-removed"
                >
                  {formatTimestamp(segment.start)}–{formatTimestamp(segment.end)}
                  <span className="lesson-segments-ai-diff-badge">removed</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <label className="lesson-segments-ai-refine-field">
          Refine this proposal
          <textarea
            className="lesson-segments-ai-textarea"
            value={refineInstruction}
            disabled={busy}
            onChange={(event) => onRefineInstructionChange(event.target.value)}
            placeholder="e.g. &quot;keep more of the ending&quot;"
            rows={2}
            aria-label="Refine the proposed segment changes"
          />
        </label>
        <p className="lesson-segments-ai-hint">
          Exact timestamps (<code>m:ss</code>, <code>h:mm:ss</code>) in your instruction are
          honored precisely.
        </p>
        <button type="button" disabled={busy || refineInstruction.trim() === ""} onClick={onRefine}>
          {previewBusy ? "Updating…" : "Update proposal"}
        </button>

        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={applyBusy}>
            Cancel
          </button>
          <button type="button" onClick={onApply} disabled={busy || isEmptyProposal}>
            {applyBusy ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
