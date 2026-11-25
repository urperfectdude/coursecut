import { useCallback, useEffect, useRef, useState } from "react";
import { getLessonCrop, upsertLessonCrop, type CropInput } from "../db";
import { normalizeCropRect } from "./CropLayers";
import type { PercentRect } from "./RegionLayers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

/** Shadow settings "Reset to defaults" goes back to (the table's defaults). */
const SHADOW_DEFAULTS: Pick<CropInput, "shadow_enabled" | "shadow_blur" | "shadow_opacity" | "shadow_offset_y"> = {
  shadow_enabled: true,
  shadow_blur: 24,
  shadow_opacity: 0.5,
  shadow_offset_y: 8,
};

/** A lesson with no crop row yet: off, with the table's defaults and a
 * centred box to start from. */
const DEFAULT_CROP: CropInput = {
  enabled: false,
  x_percent: 10,
  y_percent: 10,
  w_percent: 80,
  h_percent: 80,
  bg_color: "#0B1F3A",
  padding_percent: 6,
  ...SHADOW_DEFAULTS,
};

const SAVE_DELAY_MS = 400;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function sameCrop(a: CropInput, b: CropInput): boolean {
  return (Object.keys(a) as (keyof CropInput)[]).every((key) => a[key] === b[key]);
}

/** One undo/redo step, the shape of the lesson page's own stack. */
interface CropUndoStep {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** State and actions for a lesson's crop. Changes show at once and are
 * saved after a short pause, so a drag or a burst of typing is one save;
 * each save hands `onUndoable` an undo step back to the previous save.
 * Saves run one at a time, in order. */
export function useCropEditor(lessonId: string, onUndoable?: (step: CropUndoStep) => void) {
  const [crop, setCrop] = useState<CropInput>(DEFAULT_CROP);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the database has (or the defaults, before the first save). Only
  // moves once a save has succeeded.
  const savedRef = useRef<CropInput>(DEFAULT_CROP);
  const pendingRef = useRef<CropInput | null>(null);
  const timerRef = useRef<number | null>(null);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const onUndoableRef = useRef(onUndoable);
  onUndoableRef.current = onUndoable;

  /** The change waiting to be saved, if any, no longer waiting. */
  const takePending = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const next = pendingRef.current;
    pendingRef.current = null;
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Nothing waiting for another lesson may land on this one.
    takePending();
    setLoaded(false);
    getLessonCrop(lessonId)
      .then((row) => {
        if (cancelled) return;
        const value: CropInput = row
          ? {
              enabled: row.enabled,
              x_percent: row.x_percent,
              y_percent: row.y_percent,
              w_percent: row.w_percent,
              h_percent: row.h_percent,
              bg_color: row.bg_color,
              padding_percent: row.padding_percent,
              shadow_enabled: row.shadow_enabled,
              shadow_blur: row.shadow_blur,
              shadow_opacity: row.shadow_opacity,
              shadow_offset_y: row.shadow_offset_y,
            }
          : DEFAULT_CROP;
        savedRef.current = value;
        setCrop(value);
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [lessonId, takePending]);

  /** Writes `next` after any save already running. Resolves to an undo step
   * back to what was saved before (when `undoable` and something changed);
   * rejects on failure, leaving the saved state as it was. */
  const persist = useCallback(
    (next: CropInput, undoable: boolean): Promise<CropUndoStep | null> => {
      const run = chainRef.current.then(async () => {
        const before = savedRef.current;
        if (sameCrop(before, next)) return null;
        setSaving(true);
        try {
          await upsertLessonCrop(lessonId, next);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          throw err;
        } finally {
          setSaving(false);
        }
        savedRef.current = next;
        setError(null);
        if (!undoable) return null;
        // Undo/redo write straight away, replacing any change still waiting.
        const restore = async (value: CropInput) => {
          takePending();
          setCrop(value);
          await persist(value, false);
        };
        return { undo: () => restore(before), redo: () => restore(next) };
      });
      chainRef.current = run.catch(() => undefined);
      return run;
    },
    [lessonId, takePending],
  );

  /** Saves the change still waiting, if any, now, as its own undo step. */
  const flush = useCallback(async () => {
    const next = takePending();
    if (!next) return;
    const step = await persist(next, true);
    if (step) onUndoableRef.current?.(step);
  }, [takePending, persist]);

  /** Like `flush`, but hands the undo step back instead of passing it to
   * `onUndoable`, for an undo that should reverse exactly that change.
   * `null` when nothing was waiting (or it changed nothing). */
  const flushForUndo = useCallback(async (): Promise<CropUndoStep | null> => {
    const next = takePending();
    return next ? persist(next, true) : null;
  }, [takePending, persist]);

  // Leaving the page doesn't drop a change still waiting to be saved.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => void flushRef.current().catch(() => undefined), []);

  /** Applies `patch` now and saves it after `SAVE_DELAY_MS`. */
  const update = useCallback((patch: Partial<CropInput>) => {
    setCrop((prev) => {
      const next = { ...prev, ...patch };
      pendingRef.current = next;
      return next;
    });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flushRef.current().catch(() => undefined), SAVE_DELAY_MS);
  }, []);

  const setRect = useCallback(
    (rect: PercentRect) => {
      const normalized = normalizeCropRect(rect);
      update({ x_percent: normalized.x, y_percent: normalized.y, w_percent: normalized.w, h_percent: normalized.h });
    },
    [update],
  );

  const rect: PercentRect = { x: crop.x_percent, y: crop.y_percent, w: crop.w_percent, h: crop.h_percent };

  return { crop, rect, loaded, saving, error, update, setRect, flush, flushForUndo };
}

export type CropEditor = ReturnType<typeof useCropEditor>;

/** A number input that only reports values inside `[min, max]`, keeping
 * what's typed (e.g. "4" on the way to "45" when the minimum is 5) until
 * it's valid or the field loses focus. */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  integer = false,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // The text last reported. If the value applied for it differs (clamped
  // to the frame, rounded), show the applied value straight away.
  const committedRef = useRef<string | null>(null);
  useEffect(() => {
    if (draft !== null && draft === committedRef.current && Number(draft) !== value) setDraft(String(value));
  }, [draft, value]);
  return (
    <label className="flex flex-col gap-0.5 text-xs">
      {label}
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const number = Number(text);
          if (text.trim() === "" || !Number.isFinite(number) || number < min || number > max) return;
          if (integer && !Number.isInteger(number)) return;
          committedRef.current = text;
          onCommit(number);
        }}
        onBlur={() => {
          committedRef.current = null;
          setDraft(null);
        }}
        aria-label={label}
        className="h-7 w-20 text-xs tabular-nums"
      />
    </label>
  );
}

/** The Crop tab: one crop for the whole lesson, edited here and as a box on
 * the Final video. */
export default function CropPanel({ editor }: { editor: CropEditor }) {
  const { crop, rect, loaded, saving, error } = editor;
  const [bgDraft, setBgDraft] = useState(crop.bg_color);
  // Follow the saved colour when it changes from elsewhere (swatch, undo).
  useEffect(() => {
    setBgDraft((prev) => (prev.toLowerCase() === crop.bg_color.toLowerCase() ? prev : crop.bg_color));
  }, [crop.bg_color]);
  const bgValid = HEX_COLOR.test(bgDraft);
  const off = !loaded || !crop.enabled;
  const round2 = (value: number) => Math.round(value * 100) / 100;
  const rectField = (key: keyof PercentRect, label: string, min: number) => (
    <NumberField
      label={label}
      value={round2(rect[key])}
      min={min}
      max={100}
      step={0.1}
      disabled={off}
      onCommit={(value) => editor.setRect({ ...rect, [key]: value })}
    />
  );

  return (
    <div className="mt-6 border-t border-border pt-4">
      <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Crop</p>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={crop.enabled}
          disabled={!loaded}
          onCheckedChange={(checked) => editor.update({ enabled: checked === true })}
        />
        Enable crop
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        {crop.enabled
          ? "On the Final video, drag the box to move it, its handles to resize it, or outside it to draw a new one. The cropped picture is centred on the background, at the video's own size."
          : "Off: the lesson exports with the full frame."}
      </p>

      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {rectField("x", "X (%)", 0)}
          {rectField("y", "Y (%)", 0)}
          {rectField("w", "Width (%)", 5)}
          {rectField("h", "Height (%)", 5)}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-0.5 text-xs">
            Background
            <div className="flex items-center gap-1">
              <Input
                type="text"
                disabled={off}
                value={bgDraft}
                onChange={(event) => {
                  const text = event.target.value.trim();
                  setBgDraft(text);
                  if (HEX_COLOR.test(text)) editor.update({ bg_color: text });
                }}
                onBlur={() => setBgDraft(crop.bg_color)}
                aria-label="Background colour (hex)"
                aria-invalid={!bgValid}
                placeholder="#rrggbb"
                className="h-7 w-24 font-mono text-xs"
              />
              <input
                type="color"
                disabled={off}
                value={crop.bg_color.toLowerCase()}
                onChange={(event) => editor.update({ bg_color: event.target.value })}
                aria-label="Background colour"
                className="h-7 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
              />
            </div>
          </label>
          <NumberField
            label="Padding (%)"
            value={crop.padding_percent}
            min={0}
            max={30}
            step={0.5}
            disabled={off}
            onCommit={(value) => editor.update({ padding_percent: value })}
          />
        </div>
        {!bgValid && !off && <p className="text-xs text-destructive">Use a colour like #0B1F3A.</p>}

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={crop.shadow_enabled}
              disabled={off}
              onCheckedChange={(checked) => editor.update({ shadow_enabled: checked === true })}
            />
            Drop shadow
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <NumberField
              label="Blur (px)"
              value={crop.shadow_blur}
              min={0}
              max={200}
              step={1}
              integer
              disabled={off || !crop.shadow_enabled}
              onCommit={(value) => editor.update({ shadow_blur: value })}
            />
            <NumberField
              label="Opacity (%)"
              value={Math.round(crop.shadow_opacity * 100)}
              min={0}
              max={100}
              step={1}
              integer
              disabled={off || !crop.shadow_enabled}
              onCommit={(value) => editor.update({ shadow_opacity: value / 100 })}
            />
            <NumberField
              label="Offset Y (px)"
              value={crop.shadow_offset_y}
              min={-200}
              max={200}
              step={1}
              integer
              disabled={off || !crop.shadow_enabled}
              onCommit={(value) => editor.update({ shadow_offset_y: value })}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={off}
              onClick={() => editor.update(SHADOW_DEFAULTS)}
            >
              Reset to defaults
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Sizes are in pixels of the original recording.</p>
        </div>
      </div>

      {saving && <p className="mt-2 text-xs text-muted-foreground">Saving…</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
