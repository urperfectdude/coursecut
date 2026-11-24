import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Pencil, Trash2 } from "lucide-react";
import {
  deleteLessonSlide,
  listLessonSlides,
  saveTitleCardPng,
  upsertLessonSlide,
  type LessonSlide,
  type SlideKind,
  type SlideMode,
  type SlidePosition,
} from "../db";
import { DEFAULT_TITLE_CARD_COLORS, drawTitleCard, renderTitleCardPng } from "../lib/titleCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The intro or outro being added or edited. `imagePath` is the picked image
 * for `kind: "image"` (a saved title card's own PNG isn't reused: the card
 * is re-rendered on every save). */
interface SlideDraft {
  position: SlidePosition;
  kind: SlideKind;
  imagePath: string;
  title: string;
  subtitle: string;
  bgColor: string;
  textColor: string;
  durationDraft: string;
  mode: SlideMode;
  mute: boolean;
  error: string | null;
}

const POSITION_LABEL: Record<SlidePosition, string> = { intro: "Intro", outro: "Outro" };
const MODE_LABEL: Record<SlideMode, string> = {
  insert: "Insert as separate clip",
  overlay: "Overlay on lesson",
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** A lesson's saved intro/outro slides, for the editor and the preview. */
export function useLessonSlides(lessonId: string) {
  const [slides, setSlides] = useState<LessonSlide[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setError(null);
    try {
      setSlides(await listLessonSlides(lessonId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [lessonId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { slides, error, setError, refetch };
}

/** Live thumbnail of a title card draft, drawn the same way as the export
 * PNG, with the video's aspect ratio. */
function TitleCardThumbnail({
  title,
  subtitle,
  bgColor,
  textColor,
  aspect,
}: {
  title: string;
  subtitle: string;
  bgColor: string;
  textColor: string;
  aspect: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const width = 240;
  const height = Math.max(1, Math.round(width / aspect));
  useEffect(() => {
    if (canvasRef.current) void drawTitleCard(canvasRef.current, { title, subtitle, bgColor, textColor });
  }, [title, subtitle, bgColor, textColor, height]);
  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="rounded-sm border border-border"
      aria-label="Title card preview"
    />
  );
}

/** "Add intro" / "Add outro" and the saved intro/outro rows, rendered as a
 * sub-block of the Image overlays section. `videoSize` is the lesson video's
 * pixel size (title cards are rendered at it), `null` until it has loaded. */
export default function IntroOutroBlock({
  lessonId,
  slidesState,
  videoSize,
}: {
  lessonId: string;
  slidesState: ReturnType<typeof useLessonSlides>;
  videoSize: { width: number; height: number } | null;
}) {
  const { slides, error, setError, refetch } = slidesState;
  const [draft, setDraft] = useState<SlideDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = useCallback((changes: Partial<Omit<SlideDraft, "position" | "error">>) => {
    setDraft((prev) => (prev ? { ...prev, ...changes, error: null } : prev));
  }, []);

  function startAdd(position: SlidePosition) {
    setError(null);
    setDraft({
      position,
      kind: "image",
      imagePath: "",
      title: "",
      subtitle: "",
      ...DEFAULT_TITLE_CARD_COLORS,
      durationDraft: "4",
      mode: "insert",
      mute: false,
      error: null,
    });
  }

  function startEdit(slide: LessonSlide) {
    setError(null);
    setDraft({
      position: slide.position,
      kind: slide.kind,
      imagePath: slide.kind === "image" ? slide.image_path : "",
      title: slide.title,
      subtitle: slide.subtitle,
      bgColor: slide.bg_color,
      textColor: slide.text_color,
      durationDraft: String(slide.duration),
      mode: slide.mode,
      mute: slide.mute_audio,
      error: null,
    });
  }

  async function pickImage() {
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
      });
      if (typeof picked === "string") patch({ imagePath: picked });
    } catch (err) {
      setDraft((prev) => (prev ? { ...prev, error: err instanceof Error ? err.message : String(err) } : prev));
    }
  }

  async function save() {
    if (!draft || busy) return;
    const fail = (message: string) => setDraft((prev) => (prev ? { ...prev, error: message } : prev));
    const duration = Number(draft.durationDraft);
    if (!Number.isFinite(duration) || duration <= 0) return fail("Duration must be greater than 0.");
    if (draft.kind === "image" && !draft.imagePath) return fail("Choose an image.");
    if (draft.kind === "title" && !draft.title.trim()) return fail("Enter a title.");
    if (draft.kind === "title" && !videoSize) return fail("Wait for the video to load, then save again.");
    setBusy(true);
    try {
      let imagePath = draft.imagePath;
      if (draft.kind === "title" && videoSize) {
        const png = await renderTitleCardPng(draft, videoSize.width, videoSize.height);
        imagePath = await saveTitleCardPng(png);
      }
      await upsertLessonSlide(lessonId, {
        position: draft.position,
        mode: draft.mode,
        duration,
        kind: draft.kind,
        image_path: imagePath,
        title: draft.title.trim(),
        subtitle: draft.subtitle.trim(),
        bg_color: draft.bgColor,
        text_color: draft.textColor,
        mute_audio: draft.mode === "overlay" && draft.mute,
      });
      setDraft(null);
      await refetch();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(slide: LessonSlide) {
    setError(null);
    try {
      await deleteLessonSlide(slide.id);
      if (draft?.position === slide.position) setDraft(null);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const byPosition = (position: SlidePosition) => slides.find((slide) => slide.position === position);
  const aspect = videoSize ? videoSize.width / videoSize.height : 16 / 9;

  return (
    <div className="mt-4">
      <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Intro &amp; outro</p>

      <div className="flex flex-wrap items-end gap-3">
        {(["intro", "outro"] as const).map((position) =>
          byPosition(position) || draft?.position === position ? null : (
            <Button
              key={position}
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => startAdd(position)}
            >
              Add {position}
            </Button>
          ),
        )}
      </div>

      {draft && (
        <div className="mt-3 flex flex-col gap-3 rounded-md border border-border p-2">
          <p className="text-xs font-semibold">
            {byPosition(draft.position) ? "Edit" : "Add"} {draft.position}
          </p>

          <div className="flex gap-1" role="group" aria-label="Slide type">
            {(["image", "title"] as const).map((kind) => (
              <Button
                key={kind}
                type="button"
                size="sm"
                variant={draft.kind === kind ? "secondary" : "ghost"}
                aria-pressed={draft.kind === kind}
                disabled={busy}
                onClick={() => patch({ kind })}
              >
                {kind === "image" ? "Image" : "Title card"}
              </Button>
            ))}
          </div>

          {draft.kind === "image" ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void pickImage()}>
                {draft.imagePath ? "Change image" : "Choose image"}
              </Button>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {draft.imagePath ? fileName(draft.imagePath) : "PNG or JPG"}
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-0.5 text-xs">
                  Title
                  <Input
                    type="text"
                    disabled={busy}
                    value={draft.title}
                    onChange={(event) => patch({ title: event.target.value })}
                    className="h-7 w-64 text-xs"
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-xs">
                  Subtitle
                  <Input
                    type="text"
                    disabled={busy}
                    value={draft.subtitle}
                    onChange={(event) => patch({ subtitle: event.target.value })}
                    className="h-7 w-64 text-xs"
                  />
                </label>
                <div className="flex gap-3">
                  <label className="flex items-center gap-1.5 text-xs">
                    Background
                    <input
                      type="color"
                      disabled={busy}
                      value={draft.bgColor}
                      onChange={(event) => patch({ bgColor: event.target.value })}
                      className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    Text
                    <input
                      type="color"
                      disabled={busy}
                      value={draft.textColor}
                      onChange={(event) => patch({ textColor: event.target.value })}
                      className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
                    />
                  </label>
                </div>
              </div>
              <TitleCardThumbnail
                title={draft.title}
                subtitle={draft.subtitle}
                bgColor={draft.bgColor}
                textColor={draft.textColor}
                aspect={aspect}
              />
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-0.5 text-xs">
              Duration (s)
              <Input
                type="number"
                min="0.1"
                step="0.1"
                disabled={busy}
                value={draft.durationDraft}
                onChange={(event) => patch({ durationDraft: event.target.value })}
                className="h-7 w-20 text-xs tabular-nums"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-xs">
              Mode
              <Select
                value={draft.mode}
                disabled={busy}
                onValueChange={(value) => patch({ mode: value as SlideMode })}
              >
                <SelectTrigger size="sm" className="w-52 text-xs" aria-label="Mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["insert", "overlay"] as const).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {MODE_LABEL[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {draft.mode === "overlay" && (
              <label className="flex items-center gap-2 pb-1.5 text-xs">
                <Checkbox
                  checked={draft.mute}
                  disabled={busy}
                  onCheckedChange={(checked) => patch({ mute: checked === true })}
                />
                Mute lecture audio while showing
              </label>
            )}
          </div>

          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
          {draft.error && <p className="text-xs text-destructive">{draft.error}</p>}
        </div>
      )}

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {slides.length > 0 && (
        <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0">
          {slides.map((slide) => (
            <li
              key={slide.id}
              className="flex items-center justify-between gap-2 border-b border-border py-1.5 px-2 text-sm last:border-b-0"
            >
              <span className="truncate">
                {POSITION_LABEL[slide.position]} ·{" "}
                {slide.kind === "title" ? `Title card “${slide.title}”` : fileName(slide.image_path)}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {slide.duration}s · {MODE_LABEL[slide.mode]}
                {slide.mode === "overlay" && slide.mute_audio ? " · muted" : ""}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                aria-label={`Edit ${slide.position}`}
                title={`Edit ${slide.position}`}
                onClick={() => startEdit(slide)}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="icon-sm"
                disabled={busy}
                aria-label={`Delete ${slide.position}`}
                title={`Delete ${slide.position}`}
                onClick={() => void remove(slide)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
