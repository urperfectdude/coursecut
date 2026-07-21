import { useCallback, useEffect, useState } from "react";
import { listLessonSegments, type Lesson, type LessonSegment } from "../db";
import LessonPreviewPlayer from "./LessonPreviewPlayer";

interface LessonCardProps {
  lesson: Lesson;
  videoFilePath: string;
  isSelected: boolean;
  onSelect: (lessonId: string) => void;
  isBusy: boolean;
  titleDraft: string | undefined;
  onTitleDraftChange: (value: string) => void;
  onCommitTitle: (lesson: Lesson) => void;
  onDelete: (lesson: Lesson) => void;
  next: Lesson | null;
  isNextBusy: boolean;
  onMergeWithNext: (lesson: Lesson, next: Lesson) => void;
  /** Navigates to this lesson's own segment-editing page (`LessonSegmentsView`)
   * — see the conversation that moved segment editing off this tile: it used
   * to expand inline here, breaking this card out to the full grid row width. */
  onOpenSegments: (lesson: Lesson) => void;
  selectedForExport: boolean;
  onToggleExportSelection: (lessonId: string) => void;
  exporting: boolean;
  onExport: (lessonIds: string[]) => void;
  /** Bumped by the parent after any segment-affecting mutation (add-segment
   * from `SourceVideoPreview`, split, merge, or an edit made on this
   * lesson's own `LessonSegmentsView` page) — this card's own locally
   * fetched preview segments refetch in response. */
  segmentsRefreshKey: number;
}

/** One lesson's tile in the editor's grid (`.lesson-tile-grid`). Selecting a
 * card (`isSelected`) only targets it for `SourceVideoPreview`'s Mark
 * In/Out/Add Segment controls above the grid — it no longer expands this
 * tile in place; segment editing (start/end/trim/split/delete) lives on its
 * own page now, opened via "Edit segments" (see `onOpenSegments`). This tile
 * shows a read-only, always-visible preview of the lesson's own footage via
 * `LessonPreviewPlayer`. */
export default function LessonCard({
  lesson,
  videoFilePath,
  isSelected,
  onSelect,
  isBusy,
  titleDraft,
  onTitleDraftChange,
  onCommitTitle,
  onDelete,
  next,
  isNextBusy,
  onMergeWithNext,
  onOpenSegments,
  selectedForExport,
  onToggleExportSelection,
  exporting,
  onExport,
  segmentsRefreshKey,
}: LessonCardProps) {
  const [segments, setSegments] = useState<LessonSegment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);

  const fetchSegments = useCallback(async () => {
    setSegmentsLoading(true);
    setSegmentsError(null);
    try {
      setSegments(await listLessonSegments(lesson.id));
    } catch (err) {
      setSegmentsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSegmentsLoading(false);
    }
  }, [lesson.id]);

  useEffect(() => {
    void fetchSegments();
  }, [fetchSegments, segmentsRefreshKey]);

  return (
    <li className={"lesson-card" + (isSelected ? " lesson-card-selected" : "")}>
      <div className="lesson-card-header" onClick={() => onSelect(lesson.id)}>
        <div className="lesson-card-title-row">
          <input
            type="checkbox"
            className="lesson-export-checkbox"
            checked={selectedForExport}
            onClick={(event) => event.stopPropagation()}
            onChange={() => onToggleExportSelection(lesson.id)}
            aria-label={`Select lesson ${lesson.title} for export`}
          />
          <input
            type="text"
            className="lesson-title-input"
            value={titleDraft ?? lesson.title}
            disabled={isBusy}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onTitleDraftChange(event.target.value)}
            onBlur={() => onCommitTitle(lesson)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            aria-label={`Rename lesson ${lesson.title}`}
          />
        </div>
        <div className="lesson-card-badge-row">
          <span className={`kind-badge kind-${lesson.kind} kind-badge-small`}>{lesson.kind}</span>
          {lesson.confidence !== null && (
            <span className="confidence-badge confidence-badge-small">
              {Math.round(lesson.confidence * 100)}% confidence
            </span>
          )}
        </div>
      </div>

      <div className="lesson-item-actions">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenSegments(lesson);
          }}
        >
          Edit segments
        </button>
        <button
          type="button"
          disabled={exporting}
          onClick={(event) => {
            event.stopPropagation();
            onExport([lesson.id]);
          }}
        >
          Export
        </button>
        {next && (
          <button
            type="button"
            disabled={isBusy || isNextBusy}
            onClick={(event) => {
              event.stopPropagation();
              onMergeWithNext(lesson, next);
            }}
          >
            Merge with next
          </button>
        )}
        <button
          type="button"
          className="delete-button"
          disabled={isBusy}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(lesson);
          }}
        >
          Delete
        </button>
      </div>

      <div className="lesson-card-preview">
        <LessonPreviewPlayer videoFilePath={videoFilePath} segments={segments} lessonTitle={lesson.title} />
        {segmentsLoading && <p>Loading segments…</p>}
        {segmentsError && <p className="error">{segmentsError}</p>}
      </div>
    </li>
  );
}
