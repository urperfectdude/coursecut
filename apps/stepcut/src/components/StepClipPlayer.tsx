// A per-step preview player — one `<video>` per step row, clamped to that
// step's own `[start, end)` range so it plays (and scrubs) as if that were
// the whole file, rather than a moment inside the full recording.
//
// Deliberately not `<video controls>` (unlike the full-recording player in
// `StepsEditorView`): native controls show the *file's* duration and
// scrubber, which for a 40-minute recording would render a step's 4-second
// clip as an invisible sliver. This is a small bespoke transport instead —
// Play/Pause plus a `SegmentedScrubber` whose `min`/`max` are the step's own
// bounds — the same "generic min/max scrubber, no player-specific logic in
// it" split `SourceVideoPreview`/`LessonPreviewPlayer` use in apps/web,
// scaled down to what a single fixed range needs.
//
// All step clips share one presigned `src` (the same short-TTL URL
// `useVideoSrc` mints for the full recording) — a step clip is not a
// separately stored object, just a bounded view over the same file. With
// `preload="metadata"` a mounted-but-unplayed clip fetches only enough bytes
// for its duration, not the whole recording, so having one `<video>` per
// step stays cheap until the user actually presses play on it.

import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import SegmentedScrubber from "@/components/SegmentedScrubber";
import { formatTimestamp } from "@/lib/timestamp";

interface StepClipPlayerProps {
  src: string | undefined;
  start: number;
  end: number;
}

/** How close to `end` counts as "arrived" — playback is stopped and rewound
 * a frame early rather than exactly at `end`, since `timeupdate` fires at
 * irregular intervals and can land past it. */
const END_EPSILON_SECS = 0.05;

export default function StepClipPlayer({ src, start, end }: StepClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [relativeTime, setRelativeTime] = useState(0);

  // A step's own bounds can change (a Start/End edit, a split) while its
  // clip is mounted — reset to the new range rather than keep playing
  // against the stale one.
  useEffect(() => {
    setReady(false);
    setEnded(false);
    setRelativeTime(0);
    const video = videoRef.current;
    if (video) video.currentTime = start;
  }, [start, end]);

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = start;
    setReady(true);
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.currentTime >= end - END_EPSILON_SECS) {
      video.pause();
      setPlaying(false);
      setEnded(true);
      setRelativeTime(end - start);
      return;
    }
    setRelativeTime(Math.max(0, video.currentTime - start));
  };

  const handlePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.pause();
      setPlaying(false);
      return;
    }
    if (ended || video.currentTime < start || video.currentTime >= end) {
      video.currentTime = start;
    }
    setEnded(false);
    void video.play();
    setPlaying(true);
  };

  const handleScrub = (event: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Number(event.target.value);
    video.currentTime = start + next;
    setRelativeTime(next);
    setEnded(next >= end - start - END_EPSILON_SECS);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2">
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        playsInline
        className="aspect-video max-h-40 w-full rounded bg-black object-contain"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={handlePlayPause}
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={!src || !ready}
          onClick={handlePlayPause}
          aria-label={playing ? "Pause step preview" : ended ? "Replay step preview" : "Play step preview"}
        >
          {playing ? <Pause /> : ended ? <RotateCcw /> : <Play />}
        </Button>
        <SegmentedScrubber
          min={0}
          max={Math.max(end - start, 0.01)}
          step={0.01}
          value={relativeTime}
          onChange={handleScrub}
          disabled={!src || !ready}
          aria-label="Step preview position"
          className="flex-1"
        />
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {formatTimestamp(relativeTime)} / {formatTimestamp(end - start)}
        </span>
      </div>
    </div>
  );
}
