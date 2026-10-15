// A template's styled-frame settings — background, padding, rounded corners,
// shadow — with a live CSS preview scaled down from the template's real
// output size. What the worker renders is `apps/stepcut-worker/src/
// effects.ts`/`ffmpeg.ts`'s `prepareFrameAssets`; this preview approximates
// it (CSS `box-shadow` is not ffmpeg's `gblur`, but the proportions match).
//
// Draft-then-save rather than save-per-change: dragging a slider would
// otherwise send a PATCH per pixel.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  updateTemplate,
  uploadTemplateAsset,
  type BackgroundKind,
  type FrameStylePatch,
  type Template,
} from "@/api/templates";

interface FrameStyleEditorProps {
  template: Template;
  onSaved: (template: Template) => void;
  onError: (message: string) => void;
}

type Draft = Required<FrameStylePatch> & { background_color2: string };

const BACKGROUND_KINDS: Array<{ value: BackgroundKind; label: string }> = [
  { value: "none", label: "None (black bars)" },
  { value: "color", label: "Solid color" },
  { value: "gradient", label: "Gradient" },
  { value: "image", label: "Image" },
];

/** Width of the preview box in CSS pixels; everything else scales from the
 * template's real output width. */
const PREVIEW_WIDTH = 320;

function draftOf(template: Template): Draft {
  return {
    background_kind: template.background_kind,
    background_color: template.background_color,
    background_color2: template.background_color2 ?? "#f97316",
    frame_padding_px: template.frame_padding_px,
    frame_radius_px: template.frame_radius_px,
    frame_shadow: template.frame_shadow,
  };
}

function previewBackground(draft: Draft): string {
  switch (draft.background_kind) {
    case "color":
      return draft.background_color;
    case "gradient":
      return `linear-gradient(135deg, ${draft.background_color}, ${draft.background_color2})`;
    case "image":
      return "repeating-conic-gradient(#9ca3af 0% 25%, #d1d5db 0% 50%) 50% / 16px 16px";
    default:
      return "#000";
  }
}

export default function FrameStyleEditor({ template, onSaved, onError }: FrameStyleEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(template));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A save or upload elsewhere hands back a fresher row — resync from it.
  useEffect(() => setDraft(draftOf(template)), [template]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(template));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await updateTemplate(template.id, draft));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const uploadBackground = async (file: File) => {
    setUploading(true);
    try {
      await uploadTemplateAsset(template.id, "background", file);
      // Saved together with the rest of the draft: the upload hands back a
      // fresh row, which would otherwise resync the draft and drop the
      // unsaved "Image" choice that revealed this button in the first place.
      onSaved(await updateTemplate(template.id, { ...draft, background_kind: "image" }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Preview geometry: the recording is drawn as a 16:9 placeholder fitted
  // inside the padded frame, the common case for a screen recording.
  const scale = PREVIEW_WIDTH / template.target_width;
  const previewHeight = template.target_height * scale;
  const padding = draft.frame_padding_px * scale;
  const availW = PREVIEW_WIDTH - 2 * padding;
  const availH = previewHeight - 2 * padding;
  const boxW = Math.max(0, Math.min(availW, (availH * 16) / 9));
  const boxH = (boxW * 9) / 16;

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row">
      <div
        className="relative shrink-0 overflow-hidden rounded"
        style={{ width: PREVIEW_WIDTH, maxWidth: "100%", height: previewHeight, background: previewBackground(draft) }}
        aria-label="Frame preview"
      >
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-gradient-to-br from-slate-100 to-slate-300"
          style={{
            width: boxW,
            height: boxH,
            borderRadius: draft.frame_radius_px * scale,
            boxShadow:
              draft.frame_shadow > 0
                ? `0 ${Math.round(boxH * 0.015)}px ${Math.round(boxH * 0.06)}px rgba(0,0,0,${draft.frame_shadow})`
                : undefined,
          }}
        >
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">
            recording
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 text-xs">
        <label className="flex items-center justify-between gap-2">
          Background
          <select
            value={draft.background_kind}
            onChange={(event) => set("background_kind", event.target.value as BackgroundKind)}
            className="h-7 rounded-md border border-input bg-transparent px-2"
          >
            {BACKGROUND_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </label>

        {(draft.background_kind === "color" || draft.background_kind === "gradient") && (
          <div className="flex items-center justify-between gap-2">
            {draft.background_kind === "gradient" ? "Colors" : "Color"}
            <span className="flex gap-1">
              <input
                type="color"
                value={draft.background_color}
                onChange={(event) => set("background_color", event.target.value)}
                aria-label="Background color"
              />
              {draft.background_kind === "gradient" && (
                <input
                  type="color"
                  value={draft.background_color2}
                  onChange={(event) => set("background_color2", event.target.value)}
                  aria-label="Second gradient color"
                />
              )}
            </span>
          </div>
        )}

        {draft.background_kind === "image" && (
          <div className="flex items-center justify-between gap-2">
            {template.background_key ? "Image uploaded" : "No image yet (renders as solid color)"}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadBackground(file);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "Uploading…" : template.background_key ? "Replace" : "Upload"}
            </Button>
          </div>
        )}

        <label className="flex items-center justify-between gap-2">
          Padding
          <span className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={Math.min(400, Math.floor(Math.min(template.target_width, template.target_height) / 3))}
              value={draft.frame_padding_px}
              onChange={(event) => set("frame_padding_px", Number(event.target.value))}
            />
            <span className="w-10 text-right tabular-nums">{draft.frame_padding_px}px</span>
          </span>
        </label>
        <label className="flex items-center justify-between gap-2">
          Corner radius
          <span className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={200}
              value={draft.frame_radius_px}
              onChange={(event) => set("frame_radius_px", Number(event.target.value))}
            />
            <span className="w-10 text-right tabular-nums">{draft.frame_radius_px}px</span>
          </span>
        </label>
        <label className="flex items-center justify-between gap-2">
          Shadow
          <span className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.frame_shadow}
              onChange={(event) => set("frame_shadow", Number(event.target.value))}
            />
            <span className="w-10 text-right tabular-nums">{Math.round(draft.frame_shadow * 100)}%</span>
          </span>
        </label>

        <div className="flex justify-end gap-2">
          {dirty && (
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(draftOf(template))}>
              Reset
            </Button>
          )}
          <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save frame style"}
          </Button>
        </div>
      </div>
    </div>
  );
}
