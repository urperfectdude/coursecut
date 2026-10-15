// The step editor's full-recording player, plus the zoom/speed effects laid
// over it: a timeline strip, a live preview, and a list of regions to edit.
//
// Effects live on the video's source timeline, not on steps (see
// `apps/stepcut-api/src/db/schema.ts`'s "Effects" section), so this sits
// above the step list rather than inside a step row, and a zoom stays put
// when a step boundary moves.
//
// Preview: with "Preview effects" on, a `requestAnimationFrame` loop applies
// `lib/effects.ts`'s zoom as a CSS transform on the `<video>` and sets its
// `playbackRate` for speed regions — the browser twin of what the worker
// renders. Native controls are swapped for a small transport while previewing,
// since a transform on the `<video>` would zoom its built-in controls too.
//
// Suggested zooms are previewed alongside accepted ones so they can be judged
// in motion, but only accepted zooms are part of a render.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SegmentedScrubber from "@/components/SegmentedScrubber";
import {
  addSpeed,
  addZoom,
  deleteSpeed,
  deleteZoom,
  dismissZoomSuggestions,
  getEffects,
  suggestZooms,
  updateSpeed,
  updateZoom,
  type SpeedRegion,
  type VideoEffects,
  type ZoomRegion,
} from "@/api/effects";
import { getJobs, type Job, type Step } from "@/api/videos";
import { rateAt, zoomAt, zoomTransform } from "@/lib/effects";
import { formatTimestamp, formatTimestampMs, parseTimestampMs } from "@/lib/timestamp";
import { cn } from "@/lib/utils";

interface VideoEffectsEditorProps {
  videoId: string;
  src: string | undefined;
  /** From the API; the `<video>`'s own metadata fills in if it's missing. */
  duration: number | null;
  steps: Step[];
  currentTime: number;
  onTimeUpdate: (time: number) => void;
  onError: (message: string | null) => void;
}

const NEW_REGION_SECS = 3;
const DEFAULT_ZOOM_SCALE = 1.8;
const DEFAULT_SPEED_RATE = 2;
const SPEED_RATES = [0.25, 0.5, 0.75, 1.25, 1.5, 2, 3, 4];
const JOB_POLL_MS = 2000;
/** The API's minimum lengths (`domain/effects.ts`). */
const MIN_ZOOM_SECS = 0.5;
const MIN_SPEED_SECS = 0.2;

type Region = { kind: "zoom"; region: ZoomRegion } | { kind: "speed"; region: SpeedRegion };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function VideoEffectsEditor({
  videoId,
  src,
  duration: apiDuration,
  steps,
  currentTime,
  onTimeUpdate,
  onError,
}: VideoEffectsEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [effects, setEffects] = useState<VideoEffects>({ zooms: [], speeds: [] });
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [preview, setPreview] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [pickingZoomId, setPickingZoomId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The guard itself reads a ref: `busy` state is stale inside a closure
  // from the same render, so two fast clicks would both get through.
  const busyRef = useRef(false);
  const [suggestJob, setSuggestJob] = useState<Job | undefined>(undefined);

  const duration = apiDuration ?? mediaDuration ?? 0;

  const refresh = useCallback(async () => {
    setEffects(await getEffects(videoId));
  }, [videoId]);

  useEffect(() => {
    refresh().catch((err) => onError(message(err)));
    // Pick up a suggestion job that was already running before this mount.
    getJobs(videoId)
      .then((jobs) => setSuggestJob(jobs.find((job) => job.kind === "zooms")))
      .catch(() => undefined);
  }, [refresh, videoId, onError]);

  // --- Live preview --------------------------------------------------------

  const effectsRef = useRef(effects);
  effectsRef.current = effects;
  const pickingRef = useRef(pickingZoomId);
  pickingRef.current = pickingZoomId;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!preview) {
      video.style.transform = "none";
      video.playbackRate = 1;
      return;
    }
    let frame = 0;
    const tick = () => {
      const t = video.currentTime;
      const { zooms, speeds } = effectsRef.current;
      // While choosing a focus point the frame has to be unzoomed, or the
      // click would land on the wrong spot.
      video.style.transform = pickingRef.current ? "none" : zoomTransform(zoomAt(t, zooms));
      const rate = rateAt(t, speeds);
      if (video.playbackRate !== rate) video.playbackRate = rate;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [preview, src]);

  const seek = (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, time), duration || time);
    onTimeUpdate(video.currentTime);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  // --- Mutations -----------------------------------------------------------

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await action();
        await refresh();
        onError(null);
      } catch (err) {
        onError(message(err));
        await refresh().catch(() => undefined);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [refresh, onError],
  );

  /** A new region starting at the playhead — or, near the end of the
   * recording, ending at it, so it still meets the minimum length. */
  const newRange = (minLength: number) => {
    const end = duration > 0 ? Math.min(duration, currentTime + NEW_REGION_SECS) : currentTime + NEW_REGION_SECS;
    const start = end - currentTime >= minLength ? currentTime : Math.max(0, end - NEW_REGION_SECS);
    return { start, end };
  };

  const handleAddZoom = () =>
    run(async () => {
      const { start, end } = newRange(MIN_ZOOM_SECS);
      const created = await addZoom(videoId, { start, end, scale: DEFAULT_ZOOM_SCALE, focus_x: 0.5, focus_y: 0.5 });
      setPickingZoomId(created.id);
      videoRef.current?.pause();
    });

  const handleAddSpeed = () =>
    run(() => {
      const { start, end } = newRange(MIN_SPEED_SECS);
      return addSpeed(videoId, { start, end, rate: DEFAULT_SPEED_RATE });
    });

  const handlePickFocus = (event: React.MouseEvent<HTMLDivElement>) => {
    const id = pickingZoomId;
    if (!id) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const focusX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const focusY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    setPickingZoomId(null);
    void run(() =>
      updateZoom(id, { focus_x: Math.round(focusX * 1000) / 1000, focus_y: Math.round(focusY * 1000) / 1000 }),
    );
  };

  const handleSuggest = () =>
    run(async () => {
      setSuggestJob(await suggestZooms(videoId));
    });

  const suggestRunning = suggestJob?.state === "queued" || suggestJob?.state === "running";

  useEffect(() => {
    if (!suggestRunning) return;
    const interval = setInterval(() => {
      void getJobs(videoId)
        .then(async (jobs) => {
          const latest = jobs.find((job) => job.kind === "zooms");
          setSuggestJob(latest);
          if (latest && latest.state !== "queued" && latest.state !== "running") {
            await refresh();
            if (latest.state === "failed") onError(latest.error ?? "Finding zoom moments failed.");
          }
        })
        .catch(() => undefined);
    }, JOB_POLL_MS);
    return () => clearInterval(interval);
  }, [suggestRunning, videoId, refresh, onError]);

  // --- Derived -------------------------------------------------------------

  const regions: Region[] = useMemo(
    () =>
      [
        ...effects.zooms.map((region): Region => ({ kind: "zoom", region })),
        ...effects.speeds.map((region): Region => ({ kind: "speed", region })),
      ].sort((a, b) => a.region.start - b.region.start),
    [effects],
  );
  const suggestedCount = effects.zooms.filter((zoom) => zoom.source === "suggested").length;
  const pickingZoom = effects.zooms.find((zoom) => zoom.id === pickingZoomId);
  const pct = (seconds: number) => (duration > 0 ? `${(seconds / duration) * 100}%` : "0%");

  return (
    <div className="mb-6 flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          src={src}
          controls={!preview}
          playsInline
          className="block w-full origin-top-left"
          onLoadedMetadata={(event) => setMediaDuration(event.currentTarget.duration || null)}
          onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={preview && !pickingZoomId ? togglePlay : undefined}
        />
        {pickingZoom && (
          <div
            className="absolute inset-0 cursor-crosshair bg-black/20"
            onClick={handlePickFocus}
            role="button"
            aria-label="Click where this zoom should focus"
          >
            <span
              className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{ left: `${pickingZoom.focus_x * 100}%`, top: `${pickingZoom.focus_y * 100}%` }}
            />
            <span className="pointer-events-none absolute inset-x-0 top-2 text-center text-sm font-medium text-white drop-shadow">
              Click where this zoom should focus
            </span>
          </div>
        )}
      </div>

      {preview && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={!src}
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <SegmentedScrubber
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.01}
            value={Math.min(currentTime, duration)}
            onChange={(event) => seek(Number(event.target.value))}
            disabled={!src || duration <= 0}
            aria-label="Recording position"
            className="flex-1"
          />
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
          </span>
        </div>
      )}

      {/* Timeline strip: steps along the top, zooms (blue) and speed regions
          (amber) below, playhead over everything. Click to seek. */}
      <div
        className="relative h-12 cursor-pointer overflow-hidden rounded-md border border-border bg-muted/40"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          seek(((event.clientX - rect.left) / rect.width) * duration);
        }}
        role="presentation"
      >
        {steps.map((step, index) => (
          <span
            key={step.id}
            className={cn("absolute top-0 h-2", index % 2 === 0 ? "bg-foreground/25" : "bg-foreground/10")}
            style={{ left: pct(step.start), width: pct(step.end - step.start) }}
            title={step.title}
          />
        ))}
        {effects.zooms.map((zoom) => (
          <span
            key={zoom.id}
            className={cn(
              "absolute top-3 h-4 rounded-sm",
              zoom.source === "suggested" ? "border border-dashed border-sky-500 bg-sky-500/15" : "bg-sky-500/70",
            )}
            style={{ left: pct(zoom.start), width: pct(zoom.end - zoom.start) }}
            title={`Zoom ${zoom.scale}×${zoom.source === "suggested" ? " (suggested)" : ""}`}
          />
        ))}
        {effects.speeds.map((speed) => (
          <span
            key={speed.id}
            className="absolute top-8 h-3 rounded-sm bg-amber-500/70"
            style={{ left: pct(speed.start), width: pct(speed.end - speed.start) }}
            title={`Speed ${speed.rate}×`}
          />
        ))}
        <span className="pointer-events-none absolute inset-y-0 w-px bg-primary" style={{ left: pct(currentTime) }} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy || !src} onClick={() => void handleAddZoom()}>
          + Zoom at {formatTimestamp(currentTime)}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || !src} onClick={() => void handleAddSpeed()}>
          + Speed at {formatTimestamp(currentTime)}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || suggestRunning}
          onClick={() => void handleSuggest()}
        >
          {suggestRunning
            ? `${suggestJob?.detail ?? "Finding zoom moments"}${
                suggestJob?.progress != null ? ` ${Math.round(suggestJob.progress * 100)}%` : "…"
              }`
            : "Suggest zooms"}
        </Button>
        {suggestedCount > 0 && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  Promise.all(
                    effects.zooms.filter((zoom) => zoom.source === "suggested").map((zoom) => updateZoom(zoom.id, {})),
                  ),
                )
              }
            >
              Accept {suggestedCount} suggested
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => dismissZoomSuggestions(videoId))}
            >
              Dismiss suggestions
            </Button>
          </>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)} />
          Preview effects
        </label>
      </div>

      {regions.length > 0 && (
        <ul className="flex flex-col gap-2">
          {regions.map((entry) =>
            entry.kind === "zoom" ? (
              <ZoomRow
                key={entry.region.id}
                zoom={entry.region}
                busy={busy}
                picking={pickingZoomId === entry.region.id}
                onSeek={() => seek(entry.region.start)}
                onPatch={(patch) => void run(() => updateZoom(entry.region.id, patch))}
                onPickFocus={() => {
                  videoRef.current?.pause();
                  seek(entry.region.start + Math.min(1, (entry.region.end - entry.region.start) / 2));
                  setPickingZoomId((current) => (current === entry.region.id ? null : entry.region.id));
                }}
                onDelete={() => void run(() => deleteZoom(entry.region.id))}
              />
            ) : (
              <SpeedRow
                key={entry.region.id}
                speed={entry.region}
                busy={busy}
                onSeek={() => seek(entry.region.start)}
                onPatch={(patch) => void run(() => updateSpeed(entry.region.id, patch))}
                onDelete={() => void run(() => deleteSpeed(entry.region.id))}
              />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A text field that commits on blur/Enter — the editor's draft-then-commit
 * pattern, self-contained. `parse` returning `null` rejects the draft. */
function CommitField({
  value,
  format,
  parse,
  onCommit,
  disabled,
  label,
  className,
}: {
  value: number;
  format: (value: number) => string;
  parse: (input: string) => number | null;
  onCommit: (value: number) => void;
  disabled: boolean;
  label: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = parse(draft);
    setDraft(null);
    if (parsed !== null && parsed !== value) onCommit(parsed);
  };
  return (
    <Input
      type="text"
      value={draft ?? format(value)}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      aria-label={label}
      className={cn("h-7 font-mono text-xs tabular-nums", className)}
    />
  );
}

function parseNumber(input: string): number | null {
  const n = Number(input.replace(/[×x]\s*$/i, "").trim());
  return Number.isFinite(n) ? n : null;
}

function TimeFields({
  start,
  end,
  busy,
  onPatch,
}: {
  start: number;
  end: number;
  busy: boolean;
  onPatch: (patch: { start?: number; end?: number }) => void;
}) {
  return (
    <>
      <label className="flex flex-col gap-0.5 text-xs">
        Start
        <CommitField
          value={start}
          format={formatTimestampMs}
          parse={parseTimestampMs}
          onCommit={(value) => onPatch({ start: value })}
          disabled={busy}
          label="Start time"
          className="w-32"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-xs">
        End
        <CommitField
          value={end}
          format={formatTimestampMs}
          parse={parseTimestampMs}
          onCommit={(value) => onPatch({ end: value })}
          disabled={busy}
          label="End time"
          className="w-32"
        />
      </label>
    </>
  );
}

function ZoomRow({
  zoom,
  busy,
  picking,
  onSeek,
  onPatch,
  onPickFocus,
  onDelete,
}: {
  zoom: ZoomRegion;
  busy: boolean;
  picking: boolean;
  onSeek: () => void;
  onPatch: (patch: Partial<Pick<ZoomRegion, "start" | "end" | "scale">>) => void;
  onPickFocus: () => void;
  onDelete: () => void;
}) {
  const suggested = zoom.source === "suggested";
  return (
    <li
      className={cn(
        "flex flex-wrap items-end gap-2 rounded-lg border p-2",
        suggested ? "border-dashed border-sky-500/60" : "border-border",
      )}
    >
      <div className="flex flex-col gap-1 self-center">
        <Badge className="bg-sky-500/80 text-white">Zoom</Badge>
        {suggested && <Badge variant="outline">Suggested</Badge>}
      </div>
      <TimeFields start={zoom.start} end={zoom.end} busy={busy} onPatch={onPatch} />
      <label className="flex flex-col gap-0.5 text-xs">
        Scale
        <CommitField
          value={zoom.scale}
          format={(value) => `${value}×`}
          parse={parseNumber}
          onCommit={(value) => onPatch({ scale: value })}
          disabled={busy}
          label="Zoom scale"
          className="w-16"
        />
      </label>
      <Button
        type="button"
        size="sm"
        variant={picking ? "default" : "outline"}
        disabled={busy}
        onClick={onPickFocus}
        title={`Focus at ${Math.round(zoom.focus_x * 100)}%, ${Math.round(zoom.focus_y * 100)}%`}
      >
        <Crosshair /> {picking ? "Click the video…" : "Set focus"}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onSeek}>
        Go to
      </Button>
      <div className="ml-auto flex gap-2">
        {suggested && (
          <Button type="button" size="sm" disabled={busy} onClick={() => onPatch({})}>
            Accept
          </Button>
        )}
        <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={onDelete}>
          {suggested ? "Dismiss" : "Delete"}
        </Button>
      </div>
    </li>
  );
}

function SpeedRow({
  speed,
  busy,
  onSeek,
  onPatch,
  onDelete,
}: {
  speed: SpeedRegion;
  busy: boolean;
  onSeek: () => void;
  onPatch: (patch: Partial<Pick<SpeedRegion, "start" | "end" | "rate">>) => void;
  onDelete: () => void;
}) {
  const rates = SPEED_RATES.includes(speed.rate) ? SPEED_RATES : [...SPEED_RATES, speed.rate].sort((a, b) => a - b);
  return (
    <li className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2">
      <Badge className="self-center bg-amber-500/80 text-white">Speed</Badge>
      <TimeFields start={speed.start} end={speed.end} busy={busy} onPatch={onPatch} />
      <label className="flex flex-col gap-0.5 text-xs">
        Rate
        <select
          value={speed.rate}
          disabled={busy}
          onChange={(event) => onPatch({ rate: Number(event.target.value) })}
          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
          aria-label="Playback rate"
        >
          {rates.map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
      </label>
      <Button type="button" size="sm" variant="ghost" onClick={onSeek}>
        Go to
      </Button>
      <Button type="button" size="sm" variant="destructive" className="ml-auto" disabled={busy} onClick={onDelete}>
        Delete
      </Button>
    </li>
  );
}
