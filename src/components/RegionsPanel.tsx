import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  addLessonRegion,
  deleteLessonRegion,
  listLessonRegions,
  updateLessonRegion,
  type LessonRegion,
  type RegionFill,
  type RegionInput,
  type RegionShape,
} from "../db";
import { formatTimestamp, formatTimestampMs, parseTimestampMs } from "../lib/timestamp";
import type { PercentRect, PreviewRegion } from "./RegionLayers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The shape layer being added (`id: null`) or edited. Times are hh:mm:ss:fff
 * drafts on the lesson's virtual timeline, like the overlay editor's. */
export interface RegionDraft {
  id: string | null;
  startDraft: string;
  endDraft: string;
  rect: PercentRect;
  shape: RegionShape;
  fill: RegionFill;
  blurStrengthDraft: string;
  color: string;
  error: string | null;
}

const NEW_REGION_SECONDS = 5;
const DEFAULT_SHAPE_RECT: PercentRect = { x: 40, y: 40, w: 20, h: 20 };

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Keeps a rect inside the frame. */
function normalizeRect(rect: PercentRect): PercentRect {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const w = clamp(round2(rect.w), 100);
  const h = clamp(round2(rect.h), 100);
  return { x: clamp(round2(rect.x), round2(100 - w)), y: clamp(round2(rect.y), round2(100 - h)), w, h };
}

function regionLabel(region: Pick<LessonRegion, "shape" | "fill">): string {
  const shape = region.shape === "rect" ? "rectangle" : region.shape === "rounded" ? "rounded rectangle" : "ellipse";
  return `${region.fill === "blur" ? "Blurred" : "Solid"} ${shape}`;
}

/** The draft's preview shape, or `null` while its times don't parse. */
function draftToPreview(draft: RegionDraft): PreviewRegion | null {
  const start = parseTimestampMs(draft.startDraft);
  const end = parseTimestampMs(draft.endDraft);
  if (start === null || end === null || end <= start) return null;
  return {
    id: draft.id ?? "draft",
    start,
    end,
    x_percent: draft.rect.x,
    y_percent: draft.rect.y,
    w_percent: draft.rect.w,
    h_percent: draft.rect.h,
    shape: draft.shape,
    fill: draft.fill,
    blur_strength: Number(draft.blurStrengthDraft) || 1,
    color: draft.color,
  };
}

/** State and actions for a lesson's shape layers. `playhead` is the
 * Final video's virtual time, used for new regions' start and "Set to
 * playhead". */
export function useRegionEditor(lessonId: string, playhead: number) {
  const [regions, setRegions] = useState<LessonRegion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RegionDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchRegions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRegions(await listLessonRegions(lessonId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lessonId]);

  useEffect(() => {
    void fetchRegions();
  }, [fetchRegions]);

  const startAdd = useCallback(() => {
    setError(null);
    setDraft({
      id: null,
      startDraft: formatTimestampMs(playhead),
      endDraft: formatTimestampMs(playhead + NEW_REGION_SECONDS),
      rect: DEFAULT_SHAPE_RECT,
      shape: "rect",
      fill: "blur",
      blurStrengthDraft: "20",
      color: "#000000",
      error: null,
    });
  }, [playhead]);

  const startEdit = useCallback((region: LessonRegion) => {
    setError(null);
    setDraft({
      id: region.id,
      startDraft: formatTimestampMs(region.start),
      endDraft: formatTimestampMs(region.end),
      rect: { x: region.x_percent, y: region.y_percent, w: region.w_percent, h: region.h_percent },
      shape: region.shape,
      fill: region.fill,
      blurStrengthDraft: String(region.blur_strength),
      color: region.color,
      error: null,
    });
  }, []);

  const cancel = useCallback(() => setDraft(null), []);

  const patchDraft = useCallback((patch: Partial<Omit<RegionDraft, "id">>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch, error: null } : prev));
  }, []);

  const setDraftRect = useCallback((rect: PercentRect) => {
    setDraft((prev) => (prev ? { ...prev, rect: normalizeRect(rect), error: null } : prev));
  }, []);

  const setDraftTimeToPlayhead = useCallback(
    (field: "startDraft" | "endDraft") => {
      setDraft((prev) => (prev ? { ...prev, [field]: formatTimestampMs(playhead), error: null } : prev));
    },
    [playhead],
  );

  const save = useCallback(async () => {
    if (!draft || busy) return;
    const fail = (message: string) => setDraft((prev) => (prev ? { ...prev, error: message } : prev));
    const start = parseTimestampMs(draft.startDraft);
    const end = parseTimestampMs(draft.endDraft);
    if (start === null || end === null) return fail("Start and end must be in hh:mm:ss:fff format.");
    if (end <= start) return fail("End must be after start.");
    const blurStrength = Number(draft.blurStrengthDraft);
    if (!Number.isInteger(blurStrength) || blurStrength < 1 || blurStrength > 100) {
      return fail("Blur strength must be a whole number from 1 to 100.");
    }
    const rect = normalizeRect(draft.rect);
    if (rect.w <= 0 || rect.h <= 0) return fail("Draw the shape on the Final video first.");
    const input: RegionInput = {
      start,
      end,
      x_percent: rect.x,
      y_percent: rect.y,
      w_percent: rect.w,
      h_percent: rect.h,
      shape: draft.shape,
      fill: draft.fill,
      blur_strength: blurStrength,
      color: draft.color,
    };
    setBusy(true);
    try {
      if (draft.id === null) await addLessonRegion(lessonId, input);
      else await updateLessonRegion(draft.id, input);
      setDraft(null);
      await fetchRegions();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, lessonId, fetchRegions]);

  const remove = useCallback(async (id: string) => {
    setError(null);
    try {
      await deleteLessonRegion(id);
      setRegions((prev) => prev.filter((region) => region.id !== id));
      setDraft((prev) => (prev?.id === id ? null : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Saved regions (minus the one being edited) plus the live draft.
  const previewRegions = useMemo(() => {
    const saved: PreviewRegion[] = regions.filter((region) => region.id !== draft?.id);
    const draftPreview = draft ? draftToPreview(draft) : null;
    return draftPreview ? [...saved, draftPreview] : saved;
  }, [regions, draft]);

  return {
    regions,
    loading,
    error,
    draft,
    busy,
    previewRegions,
    startAdd,
    startEdit,
    cancel,
    patchDraft,
    setDraftRect,
    setDraftTimeToPlayhead,
    save,
    remove,
  };
}

export type RegionEditor = ReturnType<typeof useRegionEditor>;

/** The add/edit form for `editor.draft`. */
function RegionDraftForm({ editor }: { editor: RegionEditor }) {
  const { draft, busy } = editor;
  if (!draft) return null;
  const timeField = (field: "startDraft" | "endDraft", label: string) => (
    <label className="flex flex-col gap-0.5 text-xs">
      {label}
      <div className="flex items-center gap-1">
        <Input
          type="text"
          inputMode="numeric"
          pattern="\d+:[0-5]?\d:[0-5]?\d:\d{3}"
          placeholder="hh:mm:ss:fff"
          disabled={busy}
          value={draft[field]}
          onChange={(event) => editor.patchDraft({ [field]: event.target.value })}
          aria-label={`${label} time`}
          className="h-7 w-32 font-mono text-xs tabular-nums"
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => editor.setDraftTimeToPlayhead(field)}
        >
          Set to playhead
        </Button>
      </div>
    </label>
  );
  const rectField = (key: keyof PercentRect, label: string) => (
    <label className="flex flex-col gap-0.5 text-xs">
      {label}
      <Input
        type="number"
        min="0"
        max="100"
        step="0.1"
        disabled={busy}
        value={draft.rect[key]}
        onChange={(event) => editor.setDraftRect({ ...draft.rect, [key]: Number(event.target.value) })}
        aria-label={`Shape ${label}`}
        className="h-7 w-20 text-xs tabular-nums"
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">Drag on the Final video to draw the shape.</p>
      <div className="flex flex-wrap items-end gap-3">
        {timeField("startDraft", "Start")}
        {timeField("endDraft", "End")}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {rectField("x", "X (%)")}
        {rectField("y", "Y (%)")}
        {rectField("w", "Width (%)")}
        {rectField("h", "Height (%)")}
        <label className="flex flex-col gap-0.5 text-xs">
          Shape
          <Select
            value={draft.shape}
            disabled={busy}
            onValueChange={(value) => editor.patchDraft({ shape: value as RegionShape })}
          >
            <SelectTrigger size="sm" aria-label="Shape">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rect">Rectangle</SelectItem>
              <SelectItem value="rounded">Rounded rectangle</SelectItem>
              <SelectItem value="ellipse">Ellipse</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-0.5 text-xs">
          Fill
          <Select
            value={draft.fill}
            disabled={busy}
            onValueChange={(value) => editor.patchDraft({ fill: value as RegionFill })}
          >
            <SelectTrigger size="sm" aria-label="Fill">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="blur">Blur</SelectItem>
              <SelectItem value="solid">Solid colour</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {draft.fill === "blur" ? (
          <label className="flex flex-col gap-0.5 text-xs">
            Strength
            <Input
              type="number"
              min="1"
              max="100"
              step="1"
              disabled={busy}
              value={draft.blurStrengthDraft}
              onChange={(event) => editor.patchDraft({ blurStrengthDraft: event.target.value })}
              aria-label="Blur strength"
              className="h-7 w-20 text-xs tabular-nums"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-0.5 text-xs">
            Colour
            <input
              type="color"
              disabled={busy}
              value={draft.color}
              onChange={(event) => editor.patchDraft({ color: event.target.value })}
              aria-label="Fill colour"
              className="h-7 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void editor.save()}>
          {busy ? "Saving…" : draft.id === null ? "Add shape" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={editor.cancel}>
          Cancel
        </Button>
      </div>
      {draft.error && <p className="text-xs text-destructive">{draft.error}</p>}
    </div>
  );
}

/** The Shapes card on the lesson page: blurred/solid shape layers, timed on
 * the lesson's virtual timeline like image overlays. */
export default function RegionsPanel({ editor }: { editor: RegionEditor }) {
  const { regions, draft, loading, error } = editor;
  return (
    <div className="mt-6 border-t border-border pt-4">
      <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Shapes (blur &amp; cover)</p>

      <div className="flex flex-wrap items-end gap-3">
        <Button type="button" size="sm" variant="outline" disabled={draft !== null} onClick={editor.startAdd}>
          Add shape
        </Button>
      </div>

      {draft?.id === null && (
        <div className="mt-3 rounded-md border border-border p-2">
          <RegionDraftForm editor={editor} />
        </div>
      )}

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {loading && <p className="mt-2 text-sm text-muted-foreground">Loading shapes…</p>}

      <ul className="m-0 mt-3 list-none p-0">
        {regions.map((region) =>
          draft?.id === region.id ? (
            <li key={region.id} className="border-b border-border py-1.5 px-2 last:border-b-0">
              <p className="mb-1 text-xs font-medium">{regionLabel(region)}</p>
              <RegionDraftForm editor={editor} />
            </li>
          ) : (
            <li
              key={region.id}
              className="flex items-center justify-between gap-2 border-b border-border py-1.5 px-2 text-sm last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2 truncate">
                <span aria-hidden="true" className="size-2 rounded-full bg-violet-400" />
                {regionLabel(region)}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {formatTimestamp(region.start)}–{formatTimestamp(region.end)} · {round2(region.x_percent)}/
                {round2(region.y_percent)} · {round2(region.w_percent)}×{round2(region.h_percent)}%
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${regionLabel(region)}`}
                title="Edit shape"
                disabled={draft !== null}
                onClick={() => editor.startEdit(region)}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="icon-sm"
                aria-label={`Delete ${regionLabel(region)}`}
                title="Delete shape"
                onClick={() => void editor.remove(region.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ),
        )}
        {regions.length === 0 && !loading && <li className="text-sm text-muted-foreground">No shapes yet.</li>}
      </ul>
    </div>
  );
}
