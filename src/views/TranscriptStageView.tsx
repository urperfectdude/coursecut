import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import Breadcrumbs from "../components/Breadcrumbs";
import { basename } from "./ProjectDetailView";
import {
  analyzeVideo,
  getProject,
  getVideo,
  listLessons,
  listTranscriptSegments,
  updateTranscriptSegment,
  type Project,
  type TranscriptSegment,
  type Video,
  type VideoProgress,
} from "../db";
import { useVideoProgress } from "../hooks/useVideoProgress";
import { formatTimestamp } from "../lib/timestamp";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";

interface TranscriptStageViewProps {
  projectId: string;
  videoId: string;
  onNavigateHome: () => void;
  onNavigateProject: () => void;
  // Also reached by clicking "View lessons →" below for a video that was
  // already analyzed in a previous visit — see `hasLessons`.
  onOpenLessons: () => void;
}

/** One entry on the undo/redo stack — scoped to this stage's only editable
 * action, the transcript segment keep/delete toggle (renames live on the
 * lessons stage's own separate stack, see `LessonEditorView`). */
interface UndoableAction {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** Friendly label for a `Stage` value (`src-tauri/src/progress.rs`).
 * Duplicated from `ProjectDetailView`'s row-level copy rather than shared —
 * that one is explicitly throwaway per M2's plan notes, and this is a
 * handful of lines. */
function stageLabel(stage: VideoProgress["stage"]): string {
  switch (stage) {
    case "ExtractingAudio":
      return "Extracting audio";
    case "Transcribing":
      return "Transcribing";
    case "Analyzing":
      return "Analyzing";
  }
}

/** Transcript stage (`docs/ux-overhaul-plan.md` Phase 3 / M3) — review the
 * transcript, mark segments to drop, then Analyze to advance to the lessons
 * stage. Reachable only once a video is transcribed (see
 * `ProjectDetailView`'s `canShowTranscript` gate on the row that opens this). */
export default function TranscriptStageView({
  projectId,
  videoId,
  onNavigateHome,
  onNavigateProject,
  onOpenLessons,
}: TranscriptStageViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [video, setVideo] = useState<Video | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Whether this video already has AI-suggested lessons from a previous
  // visit — gates the "View lessons →" button, which is how a user returns
  // to the lessons stage without re-running Analyze (the M3 accept
  // criterion: navigating back to transcript and forward again must not
  // re-analyze).
  const [hasLessons, setHasLessons] = useState(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const { progress, clearProgress } = useVideoProgress();

  // Per-segment "in-flight" guard, same pattern as `LessonEditorView`'s
  // `segmentBusyRef`/`segmentBusyIds`.
  const [segmentBusyIds, setSegmentBusyIds] = useState<Set<string>>(new Set());

  const [undoStack, setUndoStack] = useState<UndoableAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoableAction[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getProject(projectId),
      getVideo(videoId),
      listTranscriptSegments(videoId),
      listLessons(videoId),
    ])
      .then(([projectRow, videoRow, segmentRows, lessonRows]) => {
        if (cancelled) return;
        setProject(projectRow);
        setVideo(videoRow);
        setSegments(segmentRows);
        setHasLessons(lessonRows.length > 0);
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
  }, [projectId, videoId]);

  const pushUndo = useCallback((action: UndoableAction) => {
    setUndoStack((prev) => [...prev, action]);
    setRedoStack([]);
  }, []);

  const handleUndo = useCallback(async () => {
    const action = undoStack[undoStack.length - 1];
    if (!action) return;
    setUndoStack((prev) => prev.slice(0, -1));
    try {
      await action.undo();
      setRedoStack((prev) => [...prev, action]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [undoStack]);

  const handleRedo = useCallback(async () => {
    const action = redoStack[redoStack.length - 1];
    if (!action) return;
    setRedoStack((prev) => prev.slice(0, -1));
    try {
      await action.redo();
      setUndoStack((prev) => [...prev, action]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [redoStack]);

  async function applySegmentKeep(segmentId: string, keep: boolean) {
    const updated = await updateTranscriptSegment(segmentId, keep);
    setSegments((prev) => prev.map((segment) => (segment.id === segmentId ? updated : segment)));
  }

  const handleToggleKeep = useCallback(
    async (segment: TranscriptSegment) => {
      setSegmentBusyIds((prev) => {
        if (prev.has(segment.id)) return prev;
        return new Set(prev).add(segment.id);
      });
      const previousKeep = segment.keep;
      const nextKeep = !previousKeep;
      try {
        await applySegmentKeep(segment.id, nextKeep);
        pushUndo({
          undo: () => applySegmentKeep(segment.id, previousKeep),
          redo: () => applySegmentKeep(segment.id, nextKeep),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSegmentBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(segment.id);
          return next;
        });
      }
    },
    [pushUndo],
  );

  const filteredSegments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return segments;
    return segments.filter((segment) => segment.text.toLowerCase().includes(query));
  }, [segments, searchQuery]);

  const handleAnalyze = useCallback(async () => {
    if (analyzing) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    // Analysis isn't part of the retry-counted extract/transcribe chain
    // (M2 scope), so it always reports as attempt 1, and always clears any
    // stale event left over from this video's extract/transcribe pass.
    clearProgress(videoId);
    try {
      await analyzeVideo(videoId, 1);
      onOpenLessons();
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }, [analyzing, videoId, clearProgress, onOpenLessons]);

  const videoProgress = progress[videoId];

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { label: "Projects", onClick: onNavigateHome },
          ...(project ? [{ label: project.name, onClick: onNavigateProject }] : []),
          ...(video ? [{ label: basename(video.file_path) }] : []),
          { label: "Transcript" },
        ]}
      />

      {loading && <p>Loading transcript…</p>}
      {error && (
        <Alert variant="destructive" className="my-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!loading && !video && <p>Video not found.</p>}

      {video && (
        <>
          <div className="my-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleUndo()}
                disabled={undoStack.length === 0}
              >
                Undo
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleRedo()}
                disabled={redoStack.length === 0}
              >
                Redo
              </Button>
            </div>
            <div className="flex items-center gap-2">
              {analyzing && (
                <span className="flex items-center gap-1.5 text-sm opacity-85">
                  {videoProgress?.fraction == null ? (
                    <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
                  ) : (
                    <Progress
                      value={Math.round(videoProgress.fraction * 100)}
                      className="h-1.5 w-16 shrink-0"
                    />
                  )}
                  <span>
                    {videoProgress ? stageLabel(videoProgress.stage) : "Working…"}
                    {videoProgress?.detail && <> ({videoProgress.detail})</>}
                  </span>
                </span>
              )}
              <Button
                type="button"
                variant={hasLessons ? "outline" : "default"}
                onClick={() => void handleAnalyze()}
                disabled={analyzing}
              >
                {hasLessons && <RotateCw />}
                {hasLessons ? "Analyze again" : "Analyze"}
              </Button>
              {hasLessons && (
                <Button type="button" onClick={onOpenLessons}>
                  View lessons →
                </Button>
              )}
            </div>
          </div>
          {analyzeError && (
            <Alert variant="destructive" className="my-2">
              <AlertDescription>{analyzeError}</AlertDescription>
            </Alert>
          )}

          <Input
            type="search"
            className="my-2"
            placeholder="Search transcript…"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            aria-label="Search transcript"
          />

          {filteredSegments.length === 0 ? (
            <p>No matching transcript segments.</p>
          ) : (
            <ul className="m-0 flex max-h-[60vh] list-none flex-col gap-1.5 overflow-y-auto p-0">
              {filteredSegments.map((segment) => {
                const isBusy = segmentBusyIds.has(segment.id);
                const checkboxId = `transcript-segment-keep-${segment.id}`;
                return (
                  <li
                    key={segment.id}
                    className={cn(
                      "flex items-center gap-3 text-sm",
                      !segment.keep && "opacity-45 line-through",
                    )}
                  >
                    <span className="shrink-0 tabular-nums opacity-60">
                      {formatTimestamp(segment.start)}–{formatTimestamp(segment.end)}
                    </span>
                    <span className="flex-1">{segment.text}</span>
                    <div className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs">
                      <Checkbox
                        id={checkboxId}
                        checked={segment.keep}
                        disabled={isBusy}
                        onCheckedChange={() => void handleToggleKeep(segment)}
                      />
                      <Label htmlFor={checkboxId}>Keep</Label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
