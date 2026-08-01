// PORTED FROM: src/components/CreateLessonModal.tsx @ 16d83e5
// DEVIATIONS: none
// One-way port — desktop is upstream. Don't edit this for web-only reasons;
// port the change to the desktop file first. See docs/web-app-plan.md §7.1,
// and re-run scripts/ui-drift.sh (which reads the SHA above) after syncing.
import { useEffect, useMemo, useState } from "react";
import { createLesson, listTranscriptSegments, type LessonSegmentRange, type TranscriptSegment } from "../db";
import { formatTimestamp } from "../lib/timestamp";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Collapses `segments` (already in `start`/`id` order, per
 * `listTranscriptSegments`) into one `{start, end}` range per contiguous run
 * of checked ids — "contiguous" meaning adjacent in this list, not merely
 * touching in time. A non-contiguous checked selection (e.g. segments 1-3
 * and 7-8 checked, 4-6 unchecked) naturally collapses into two ranges,
 * which is exactly what lets `createLesson` build a multi-segment lesson
 * from one modal submission. */
function collapseContiguousRuns(
  segments: TranscriptSegment[],
  checkedIds: Set<string>,
): LessonSegmentRange[] {
  const ranges: LessonSegmentRange[] = [];
  let current: LessonSegmentRange | null = null;
  for (const segment of segments) {
    if (!checkedIds.has(segment.id)) {
      if (current) {
        ranges.push(current);
        current = null;
      }
      continue;
    }
    if (current) {
      current.end = Math.max(current.end, segment.end);
    } else {
      current = { start: segment.start, end: segment.end };
    }
  }
  if (current) ranges.push(current);
  return ranges;
}

interface CreateLessonModalProps {
  videoId: string;
  onClose: () => void;
  /** Called after a successful create — the caller is expected to refresh
   * its lesson list and close the modal (this component doesn't close
   * itself, so the caller stays in control of that, same as `onDelete`
   * elsewhere in this codebase owning its own confirm/refresh). */
  onCreated: () => void;
}

/** Transcript segment picker (`docs/ux-overhaul-plan.md` Phase 4 / M4) —
 * opened from the lessons page's "+ Create lesson" button. Lets a user
 * build a lesson by hand from this video's `transcript_segments`, instead
 * of relying on AI analysis. */
export default function CreateLessonModal({ videoId, onClose, onCreated }: CreateLessonModalProps) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listTranscriptSegments(videoId)
      .then((rows) => {
        if (!cancelled) setSegments(rows);
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

  function toggleSegment(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const segmentRanges = useMemo(
    () => collapseContiguousRuns(segments, checkedIds),
    [segments, checkedIds],
  );

  const canCreate = title.trim() !== "" && segmentRanges.length > 0 && !creating;

  async function handleCreate() {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      await createLesson(videoId, title.trim(), segmentRanges);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" aria-label="Create lesson">
        <DialogHeader>
          <DialogTitle>Create lesson</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="create-lesson-title">Title</Label>
          <Input
            id="create-lesson-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            placeholder="Lesson title…"
          />
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading transcript…</p>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!loading && segments.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">This video has no transcript segments yet.</p>
        )}

        {segments.length > 0 && (
          <ul className="m-0 flex max-h-[60vh] list-none flex-col gap-1 overflow-y-auto p-0">
            {segments.map((segment) => {
              const checkboxId = `create-lesson-segment-${segment.id}`;
              return (
                <li key={segment.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={checkboxId}
                    checked={checkedIds.has(segment.id)}
                    onCheckedChange={() => toggleSegment(segment.id)}
                  />
                  <Label htmlFor={checkboxId} className="flex flex-1 items-center gap-2 font-normal">
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatTimestamp(segment.start)}–{formatTimestamp(segment.end)}
                    </span>
                    <span className="flex-1">{segment.text}</span>
                  </Label>
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-sm text-muted-foreground">
          {segmentRanges.length > 0
            ? `${segmentRanges.length} segment${segmentRanges.length === 1 ? "" : "s"} selected.`
            : "Check transcript segments to include — non-contiguous checks become a multi-segment lesson."}
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleCreate()} disabled={!canCreate}>
            {creating ? "Creating…" : "Create lesson"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
