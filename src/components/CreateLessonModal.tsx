import { useEffect, useMemo, useState } from "react";
import { createLesson, listTranscriptSegments, type LessonSegmentRange, type TranscriptSegment } from "../db";

/** Seconds → `m:ss` / `h:mm:ss` — duplicated from `LessonCard`'s copy rather
 * than shared, same convention as that file's own note. */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${m}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : mmss;
}

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
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-panel create-lesson-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Create lesson"
      >
        <h2>Create lesson</h2>

        <label className="create-lesson-title-field">
          Title
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            placeholder="Lesson title…"
          />
        </label>

        {loading && <p>Loading transcript…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && segments.length === 0 && !error && (
          <p>This video has no transcript segments yet.</p>
        )}

        {segments.length > 0 && (
          <ul className="create-lesson-segment-list">
            {segments.map((segment) => (
              <li key={segment.id} className="create-lesson-segment-row">
                <label>
                  <input
                    type="checkbox"
                    checked={checkedIds.has(segment.id)}
                    onChange={() => toggleSegment(segment.id)}
                  />
                  <span className="create-lesson-segment-time">
                    {formatDuration(segment.start)}–{formatDuration(segment.end)}
                  </span>
                  <span className="create-lesson-segment-text">{segment.text}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <p className="create-lesson-summary-hint">
          {segmentRanges.length > 0
            ? `${segmentRanges.length} segment${segmentRanges.length === 1 ? "" : "s"} selected.`
            : "Check transcript segments to include — non-contiguous checks become a multi-segment lesson."}
        </p>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleCreate()} disabled={!canCreate}>
            {creating ? "Creating…" : "Create lesson"}
          </button>
        </div>
      </div>
    </div>
  );
}
