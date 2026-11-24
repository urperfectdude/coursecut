import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Loader2, Mic } from "lucide-react";
import {
  AI_VOICES,
  generateLessonVoice,
  getVoiceSettings,
  saveVoiceSettings,
  type VoiceSettings,
  type VoiceTrack,
} from "../db";
import type { VoiceLine } from "../lib/voice-script";
import { formatTimestamp } from "../lib/timestamp";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** A generated track, and the script and settings it was made from, so
 * the panel can tell when it's out of date. */
export interface LessonVoiceState {
  track: VoiceTrack;
  signature: string;
}

export function voiceSignature(lines: readonly VoiceLine[], settings: VoiceSettings | null): string {
  return JSON.stringify([
    settings?.voice,
    settings?.instructions,
    lines.map((line) => [line.text, line.start.toFixed(2), line.end.toFixed(2)]),
  ]);
}

/**
 * AI voice settings: the privacy opt-in, the voice and an optional
 * speaking style. Shared by Settings and the lesson editor's AI voice tab.
 * Saves on every change.
 */
export function VoiceSettingsForm({
  settings,
  onChange,
}: {
  settings: VoiceSettings;
  onChange: (next: VoiceSettings) => void;
}) {
  const [instructions, setInstructions] = useState(settings.instructions);
  useEffect(() => setInstructions(settings.instructions), [settings.instructions]);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={settings.enabled}
          onChange={(event) => onChange({ ...settings, enabled: event.target.checked })}
        />
        <span>
          <span className="font-medium">Use AI voice</span>
          <span className="block text-muted-foreground">
            Sends the text of your lesson scripts (never the video or audio) to OpenAI's speech service, using your
            OpenAI key, to read them in a studio voice. Off by default.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="ai-voice-name">Voice</Label>
        <select
          id="ai-voice-name"
          className="h-8 rounded-md border bg-background px-2 text-sm capitalize"
          value={settings.voice}
          onChange={(event) => onChange({ ...settings, voice: event.target.value })}
        >
          {AI_VOICES.map((voice) => (
            <option key={voice} value={voice}>
              {voice}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="ai-voice-style">Speaking style (optional)</Label>
        <Textarea
          id="ai-voice-style"
          rows={2}
          maxLength={1000}
          placeholder="For example: a calm, friendly corporate trainer. Clear and unhurried."
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => {
            if (instructions.trim() !== settings.instructions) onChange({ ...settings, instructions });
          }}
        />
      </div>
    </div>
  );
}

/** Loads and saves the voice settings; `error` holds a failed save. */
export function useVoiceSettings() {
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getVoiceSettings()
      .then(setSettings)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  const save = (next: VoiceSettings) => {
    setSettings(next);
    setError(null);
    saveVoiceSettings(next)
      .then(setSettings)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  return { settings, error, save };
}

interface VoicePanelProps {
  lessonId: string;
  lines: readonly VoiceLine[];
  /** The lesson's length after cuts (the track's length). */
  lessonLength: number;
  hasWords: boolean;
  voice: LessonVoiceState | null;
  onVoice: (voice: LessonVoiceState) => void;
  /** Play the AI voice instead of the recording in the Final video. */
  listening: boolean;
  onListeningChange: (listening: boolean) => void;
  onSeek: (sourceTime: number) => void;
}

/**
 * The lesson editor's AI voice tab (HCM feature 4, first part): the script
 * the voice will read, one line per sentence, built from the words the
 * lesson keeps with the user's text fixes; Generate; and hearing it in the
 * Final video. Exports don't use the voice yet.
 */
export default function VoicePanel({
  lessonId,
  lines,
  lessonLength,
  hasWords,
  voice,
  onVoice,
  listening,
  onListeningChange,
  onSeek,
}: VoicePanelProps) {
  const { settings, error: settingsError, save } = useVoiceSettings();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ lesson_id: string; done: number; total: number }>("voice-progress", (event) => {
      if (event.payload.lesson_id === lessonId) setProgress({ done: event.payload.done, total: event.payload.total });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [lessonId]);

  const signature = useMemo(() => voiceSignature(lines, settings), [lines, settings]);
  const stale = voice !== null && voice.signature !== signature;
  // A stale track would play out of sync with the edited lesson.
  useEffect(() => {
    if (stale && listening) onListeningChange(false);
  }, [stale, listening, onListeningChange]);
  const totalChars = useMemo(() => lines.reduce((sum, line) => sum + line.text.length, 0), [lines]);

  async function generate() {
    if (busy || lines.length === 0) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const track = await generateLessonVoice(
        lessonId,
        lines.map((line) => ({ text: line.text, start: line.start, end: line.end })),
        lessonLength,
      );
      onVoice({ track, signature });
      onListeningChange(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (!hasWords) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        The AI voice reads this lesson's words. Get word timings in the Script tab first.
      </p>
    );
  }
  if (!settings) {
    return settingsError ? <p className="error mt-3">{settingsError}</p> : null;
  }

  const placements = voice && !stale ? voice.track.lines : null;

  return (
    <div className="mt-3 flex flex-col gap-4">
      {!settings.enabled ? (
        <div className="rounded-lg border bg-card p-4">
          <p className="m-0 mb-3 font-medium">Replace your voice with a studio AI voice</p>
          <VoiceSettingsForm settings={settings} onChange={save} />
          {settingsError && <p className="error mt-2">{settingsError}</p>}
        </div>
      ) : (
        <details className="rounded-lg border bg-card px-3 py-2 text-sm">
          <summary className="cursor-pointer">
            Voice: <span className="capitalize">{settings.voice}</span>
            {settings.instructions && <span className="text-muted-foreground"> · {settings.instructions}</span>}
          </summary>
          <div className="pt-3">
            <VoiceSettingsForm settings={settings} onChange={save} />
            {settingsError && <p className="error mt-2">{settingsError}</p>}
          </div>
        </details>
      )}

      {settings.enabled && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void generate()} disabled={busy || lines.length === 0}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Mic aria-hidden="true" />}
            {busy
              ? progress && progress.total > 0
                ? `Generating ${progress.done}/${progress.total}…`
                : "Building voice…"
              : voice
                ? "Generate again"
                : "Generate voice"}
          </Button>
          {voice && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={listening}
                onChange={(event) => onListeningChange(event.target.checked)}
              />
              Hear the AI voice in the Final video
            </label>
          )}
          <span className="w-full text-xs text-muted-foreground">
            {lines.length} lines, {totalChars.toLocaleString()} characters. Only new or changed lines are sent;
            unchanged ones are reused. Exports still use your recorded voice for now.
          </span>
        </div>
      )}

      {stale && (
        <p className="m-0 text-sm text-amber-400">
          The script or voice changed since this voice was made. Generate again to update it.
        </p>
      )}
      {voice && !stale && voice.track.late_lines > 0 && (
        <p className="m-0 flex items-center gap-1.5 text-sm text-amber-400">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {voice.track.late_lines === 1 ? "1 line runs" : `${voice.track.late_lines} lines run`} late: the text
          takes longer to say than you took. Shorten it in the Script tab (select words, then Edit).
        </p>
      )}
      {error && <p className="error m-0">{error}</p>}

      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {lines.map((line, i) => {
          const placement = placements?.[i];
          const late = placement !== undefined && placement.late_by > 0.3;
          return (
            <li key={`${i}:${line.sourceStart}`}>
              <button
                type="button"
                onClick={() => onSeek(line.sourceStart + 0.001)}
                className={cn(
                  "flex w-full cursor-pointer gap-3 rounded-md px-2 py-1.5 text-left text-[15px] hover:bg-muted",
                  late && "bg-amber-950/30",
                )}
                title="Play from here"
              >
                <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatTimestamp(line.start)}
                </span>
                <span className="min-w-0 flex-1">{line.text}</span>
                {placement && placement.rate > 1 && (
                  <span
                    className={cn("shrink-0 text-xs tabular-nums", late ? "text-amber-400" : "text-muted-foreground")}
                    title={late ? `Starts ${placement.late_by.toFixed(1)}s late` : "Sped up to fit"}
                  >
                    {placement.rate.toFixed(2)}×{late && ` · ${placement.late_by.toFixed(1)}s late`}
                  </span>
                )}
                {placement && placement.rate <= 1 && late && (
                  <span className="shrink-0 text-xs tabular-nums text-amber-400">
                    {placement.late_by.toFixed(1)}s late
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
