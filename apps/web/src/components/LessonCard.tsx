// PORTED FROM: src/components/LessonCard.tsx @ 16d83e5
// DEVIATIONS: none
// One-way port — desktop is upstream. Don't edit this for web-only reasons;
// port the change to the desktop file first. See docs/web-app-plan.md §7.1,
// and re-run scripts/ui-drift.sh (which reads the SHA above) after syncing.
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { listLessonSegments, type Lesson, type LessonSegment } from "../db";
import LessonPreviewPlayer from "./LessonPreviewPlayer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface LessonCardProps {
  lesson: Lesson;
  videoFilePath: string;
  isBusy: boolean;
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
  /** Bumped by the parent after any segment-affecting mutation (add-segment
   * from `SourceVideoPreview`, split, merge, or an edit made on this
   * lesson's own `LessonSegmentsView` page) — this card's own locally
   * fetched preview segments refetch in response. */
  segmentsRefreshKey: number;
}

/** One lesson's tile in the editor's grid (`.lesson-tile-grid`). No longer
 * expands in place; segment editing (start/end/trim/split/delete, and
 * adding new segments) lives on its own page now, opened via "Edit
 * segments" (see `onOpenSegments`). This tile shows a read-only,
 * always-visible preview of the lesson's own footage via
 * `LessonPreviewPlayer`. */
export default function LessonCard({
  lesson,
  videoFilePath,
  isBusy,
  onDelete,
  next,
  isNextBusy,
  onMergeWithNext,
  onOpenSegments,
  selectedForExport,
  onToggleExportSelection,
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

  const checkboxId = `lesson-export-${lesson.id}`;

  return (
    <li>
      <Card size="sm">
        <CardHeader className="cursor-pointer gap-1.5" onClick={() => onOpenSegments(lesson)}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Checkbox
              id={checkboxId}
              checked={selectedForExport}
              onClick={(event) => event.stopPropagation()}
              onCheckedChange={() => onToggleExportSelection(lesson.id)}
            />
            <Label htmlFor={checkboxId} className="sr-only">
              Select lesson {lesson.title} for export
            </Label>
            {/* Read-only here — renaming lives on the lesson's own segments
               page (`LessonSegmentsView`) now, not this grid tile. */}
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={lesson.title}>
              {lesson.title}
            </span>
          </div>
        </CardHeader>

        <CardContent className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenSegments(lesson)}>
            Edit segments
          </Button>
          {next && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy || isNextBusy}
              onClick={() => onMergeWithNext(lesson, next)}
            >
              Merge with next
            </Button>
          )}
          <Button
            type="button"
            variant="destructive"
            size="icon-sm"
            disabled={isBusy}
            aria-label={`Delete lesson ${lesson.title}`}
            title="Delete lesson"
            className="ml-auto"
            onClick={() => onDelete(lesson)}
          >
            <Trash2 />
          </Button>
        </CardContent>

        <CardContent className="lesson-card-preview">
          <LessonPreviewPlayer videoFilePath={videoFilePath} segments={segments} lessonTitle={lesson.title} />
          {segmentsLoading && <p>Loading segments…</p>}
          {segmentsError && <p className="error">{segmentsError}</p>}
        </CardContent>

        <CardContent className="flex flex-wrap items-center justify-end gap-1.5">
          <Badge variant="secondary" className="capitalize">
            {lesson.kind}
          </Badge>
          {lesson.confidence !== null && (
            <Badge variant="secondary">{Math.round(lesson.confidence * 100)}% confidence</Badge>
          )}
        </CardContent>
      </Card>
    </li>
  );
}
