// A project's dashboard — Phase 2 and Phase 3's product surface
// (docs/stepcut-plan.md §8: "Upload & transcript", "AI step proposal"),
// scoped to one project now that `apps/stepcut` has a Home screen
// (`HomeView`) sitting above it. Phase 1 shipped an empty card here. Phase 2
// extended it into an upload button, a list of the project's videos with a
// status pill, and an inline view of a transcribed video's transcript.
// Phase 3 adds a "Find steps" action and a **read-only** list of the steps
// GPT-5.5 proposes from that transcript — no editing yet — Phase 4
// (docs/stepcut-plan.md §8: "Manual editing") adds an "Edit steps" action
// once that list is non-empty, handing off to `StepsEditorView` (via
// `onEditSteps`, owned by `App.tsx`): dragging a boundary, retitling,
// split/delete/add all live there now, not in this inline panel. No
// coursecut counterpart: apps/stepcut's views are original, not ported from
// desktop.
//
// Each video is its own `Card` — a self-contained tile with its status pill
// in the header and every action (view transcript, find/view steps, delete)
// inside it — rather than a bare bordered `<li>`. That, plus
// `api/videos.ts`'s `uploadVideo` now aborting a failed single-shot upload
// instead of leaving its row stuck at `upload_status: "pending"` forever, is
// what fixes the two-tiles-for-one-file confusion a stuck upload used to
// cause: before, a failed upload never reached a terminal status, so it sat
// alongside a since-succeeded retry indefinitely, reading as a duplicate of
// the same file.
//
// No video playback here — that's `StepsEditorView`'s job now. This panel's
// own job stays "prove a transcript appears after upload, and AI-proposed
// steps appear after analyzing it," plus (Phase 4) the hand-off once there's
// something to edit.

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiError } from "@/api/http";
import { getProject, type Project } from "@/api/projects";
import {
  analyzeVideo,
  deleteVideo,
  getJobs,
  getSteps,
  getTranscript,
  listVideos,
  transcribeVideo,
  uploadVideo,
  type Job,
  type Step,
  type TranscriptSegment,
  type Video,
} from "@/api/videos";

interface DashboardViewProps {
  projectId: string;
  /** Navigates to `StepsEditorView` for a video (Phase 4). */
  onEditSteps: (videoId: string) => void;
}

/** A video is still moving through the pipeline until one of these holds —
 * the condition polling stops on. */
function isSettled(video: Video): boolean {
  return (
    video.upload_status === "failed" ||
    video.transcript_status === "transcribed" ||
    video.transcript_status === "error"
  );
}

/** What the status pill reads, mirroring the plan's
 * "uploading → extracting → transcribing → transcribed/error". */
function statusLabel(video: Video): string {
  if (video.upload_status === "pending") return "Uploading";
  if (video.upload_status === "failed") return "Upload failed";
  if (video.transcript_status === "pending") return "Extracting audio";
  if (video.transcript_status === "audio_ready") return "Transcribing";
  if (video.transcript_status === "transcribed") return "Transcribed";
  if (video.transcript_status === "error") return "Error";
  return video.transcript_status;
}

function statusVariant(video: Video): "default" | "destructive" {
  return video.upload_status === "failed" || video.transcript_status === "error"
    ? "destructive"
    : "default";
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** How often the list is re-fetched while at least one video is mid-pipeline. */
const POLL_INTERVAL_MS = 1500;

/** A video's steps panel state: what `GET /videos/:id/steps` last returned,
 * plus the most recent `analyze` job — needed because an empty `steps` array
 * is ambiguous between "still analyzing," "analysis found nothing," and
 * "analysis failed" (see `apps/stepcut-api/src/routes/videos.ts`'s header). */
interface StepsPanel {
  steps: Step[];
  job: Job | undefined;
}

function isAnalyzing(panel: StepsPanel | undefined): boolean {
  return panel?.job?.state === "queued" || panel?.job?.state === "running";
}

export default function DashboardView({ projectId, onEditSteps }: DashboardViewProps) {
  const [project, setProject] = useState<Project | undefined>(undefined);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, TranscriptSegment[] | undefined>>({});
  const [stepsExpanded, setStepsExpanded] = useState<Record<string, boolean>>({});
  const [stepsPanels, setStepsPanels] = useState<Record<string, StepsPanel | undefined>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getProject(projectId).then(setProject);
  }, [projectId]);

  const refresh = useCallback(async () => {
    try {
      setVideos(await listVideos(projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while something is still moving through the pipeline; stop
  // once everything is settled so an idle dashboard isn't quietly hitting
  // the API forever.
  useEffect(() => {
    if (videos.every(isSettled)) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [videos, refresh]);

  const loadSteps = useCallback(async (id: string) => {
    try {
      const [steps, jobs] = await Promise.all([getSteps(id), getJobs(id)]);
      setStepsPanels((current) => ({
        ...current,
        [id]: { steps, job: jobs.find((job) => job.kind === "analyze") },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Poll only a video whose steps panel is open and whose latest `analyze`
  // job is still in flight — same "stop once settled" discipline the video
  // list's own poll uses above, scoped to the one video actually waiting.
  useEffect(() => {
    const pending = Object.entries(stepsPanels)
      .filter(([id, panel]) => stepsExpanded[id] && isAnalyzing(panel))
      .map(([id]) => id);
    if (pending.length === 0) return;
    const timer = setInterval(() => {
      pending.forEach((id) => void loadSteps(id));
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [stepsPanels, stepsExpanded, loadSteps]);

  const handleFileChosen = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const video = await uploadVideo(projectId, file);
      setVideos((current) => [video, ...current]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRetryTranscribe = async (id: string) => {
    try {
      const updated = await transcribeVideo(id);
      setVideos((current) => current.map((video) => (video.id === id ? updated : video)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteVideo(id);
      setVideos((current) => current.filter((video) => video.id !== id));
      setExpanded((current) => {
        const rest = { ...current };
        delete rest[id];
        return rest;
      });
      setStepsPanels((current) => {
        const rest = { ...current };
        delete rest[id];
        return rest;
      });
      setStepsExpanded((current) => {
        const rest = { ...current };
        delete rest[id];
        return rest;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Opens the steps panel, loading it the first time. Collapsing never
   * drops the cached panel, so re-opening doesn't re-fetch or lose an
   * in-flight analysis's place. */
  const toggleSteps = (id: string) => {
    setStepsExpanded((current) => ({ ...current, [id]: !current[id] }));
    if (!stepsPanels[id]) void loadSteps(id);
  };

  /** Queues analysis, then loads the panel once so it immediately reflects
   * the freshly-queued job rather than waiting for the next poll tick. */
  const handleFindSteps = async (id: string) => {
    setStepsExpanded((current) => ({ ...current, [id]: true }));
    try {
      await analyzeVideo(id);
      await loadSteps(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // `analyzeVideo` itself failed (as opposed to the job it queues later
      // failing) — without a panel, the "Loading…" placeholder has no
      // condition that would ever clear it. An empty, job-less panel falls
      // through to the "Find steps" button instead, so Retry is available.
      setStepsPanels((current) => current[id] ? current : { ...current, [id]: { steps: [], job: undefined } });
    }
  };

  const toggleTranscript = async (id: string) => {
    if (expanded[id]) {
      setExpanded((current) => ({ ...current, [id]: undefined }));
      return;
    }
    try {
      const segments = await getTranscript(id);
      setExpanded((current) => ({ ...current, [id]: segments }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
      <div>
        <h1 className="text-lg font-semibold">{project?.name ?? "Project"}</h1>
        <p className="text-sm text-muted-foreground">
          Upload a narrated screen recording to see it transcribed, then find its steps.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFileChosen(file);
          }}
        />
        <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? "Uploading…" : "Upload a video"}
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : videos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing uploaded yet — pick a video above to get started.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {videos.map((video) => (
            <Card key={video.id}>
              <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle
                  className="truncate text-sm font-medium"
                  title={video.storage_key}
                >
                  {video.storage_key.split("/").pop()}
                </CardTitle>
                <span
                  className={
                    statusVariant(video) === "destructive"
                      ? "shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
                      : "shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                  }
                >
                  {statusLabel(video)}
                </span>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {video.transcript_status === "transcribed" && (
                    <Button variant="outline" size="sm" onClick={() => void toggleTranscript(video.id)}>
                      {expanded[video.id] ? "Hide transcript" : "View transcript"}
                    </Button>
                  )}
                  {video.transcript_status === "transcribed" && (
                    <Button variant="outline" size="sm" onClick={() => toggleSteps(video.id)}>
                      {stepsExpanded[video.id] ? "Hide steps" : "Steps"}
                    </Button>
                  )}
                  {video.transcript_status === "error" && (
                    <Button variant="outline" size="sm" onClick={() => void handleRetryTranscribe(video.id)}>
                      Retry transcription
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void handleDelete(video.id)}>
                    Delete
                  </Button>
                </div>

                {expanded[video.id] && (
                  <div className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md bg-muted/50 p-2">
                    {expanded[video.id]!.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No transcript segments.</p>
                    ) : (
                      expanded[video.id]!.map((segment) => (
                        <p key={segment.id} className="text-sm">
                          <span className="mr-2 font-mono text-xs text-muted-foreground">
                            {formatTimestamp(segment.start)}–{formatTimestamp(segment.end)}
                          </span>
                          {segment.text}
                        </p>
                      ))
                    )}
                  </div>
                )}

                {stepsExpanded[video.id] && (
                  <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-2">
                    {(() => {
                      const panel = stepsPanels[video.id];
                      if (!panel) {
                        return <p className="text-sm text-muted-foreground">Loading…</p>;
                      }
                      if (panel.steps.length > 0) {
                        return (
                          <>
                            <ol className="flex flex-col gap-2">
                              {panel.steps.map((step, index) => (
                                <li key={step.id} className="text-sm">
                                  <span className="mr-2 font-mono text-xs text-muted-foreground">
                                    {index + 1}. {formatTimestamp(step.start)}–{formatTimestamp(step.end)}
                                  </span>
                                  <span className="font-medium">{step.title}</span>
                                  {step.summary && (
                                    <p className="ml-5 text-sm text-muted-foreground">{step.summary}</p>
                                  )}
                                </li>
                              ))}
                            </ol>
                            <Button
                              type="button"
                              size="sm"
                              className="self-start"
                              onClick={() => onEditSteps(video.id)}
                            >
                              Edit steps
                            </Button>
                          </>
                        );
                      }
                      if (isAnalyzing(panel)) {
                        return (
                          <p className="text-sm text-muted-foreground">
                            {panel.job?.detail ?? "Finding steps…"}
                          </p>
                        );
                      }
                      if (panel.job?.state === "failed") {
                        return (
                          <div className="flex flex-col gap-2">
                            <p className="text-sm text-destructive">
                              {panel.job.error ?? "Step analysis failed."}
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              className="self-start"
                              onClick={() => void handleFindSteps(video.id)}
                            >
                              Retry
                            </Button>
                          </div>
                        );
                      }
                      if (panel.job?.state === "done") {
                        return (
                          <p className="text-sm text-muted-foreground">
                            No steps were found in this recording.
                          </p>
                        );
                      }
                      return (
                        <Button
                          variant="outline"
                          size="sm"
                          className="self-start"
                          onClick={() => void handleFindSteps(video.id)}
                        >
                          Find steps
                        </Button>
                      );
                    })()}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
