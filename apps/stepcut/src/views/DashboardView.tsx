// The signed-in dashboard — Phase 2's whole product surface
// (docs/stepcut-plan.md §8: "Upload & transcript"). Phase 1 shipped an
// empty card here; this extends it into an upload button, a list of the
// org's videos with a status pill, and — once a video is transcribed — an
// inline view of its transcript. No coursecut counterpart: apps/stepcut's
// views are original, not ported from desktop.
//
// No video playback and no step editor here — that's Phase 3+. This view's
// whole job is "prove a transcript appears after upload."

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { OrgSummary } from "@/auth/useOrgs";
import { ApiError } from "@/api/http";
import {
  deleteVideo,
  getTranscript,
  listVideos,
  transcribeVideo,
  uploadVideo,
  type TranscriptSegment,
  type Video,
} from "@/api/videos";

interface DashboardViewProps {
  org: OrgSummary | undefined;
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

export default function DashboardView({ org }: DashboardViewProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, TranscriptSegment[] | undefined>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setVideos(await listVideos());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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

  const handleFileChosen = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const video = await uploadVideo(file);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    <div className="mx-auto max-w-2xl p-8">
      <Card>
        <CardHeader>
          <CardTitle>{org?.name ?? "Your organization"}</CardTitle>
          <CardDescription>
            Upload a narrated screen recording to see it transcribed. Step detection and editing
            come in a later phase.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
            <ul className="flex flex-col gap-3">
              {videos.map((video) => (
                <li key={video.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium" title={video.storage_key}>
                      {video.storage_key.split("/").pop()}
                    </span>
                    <span
                      className={
                        statusVariant(video) === "destructive"
                          ? "shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
                          : "shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                      }
                    >
                      {statusLabel(video)}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {video.transcript_status === "transcribed" && (
                      <Button variant="outline" size="sm" onClick={() => void toggleTranscript(video.id)}>
                        {expanded[video.id] ? "Hide transcript" : "View transcript"}
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
                    <div className="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md bg-muted/50 p-2">
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
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
