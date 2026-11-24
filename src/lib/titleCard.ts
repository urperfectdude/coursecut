/** Title-card intro/outro slides (`lesson_slides.kind = "title"`) are drawn
 * here on a `<canvas>` and saved as a PNG at the lesson video's own
 * resolution (`renderTitleCardPng` + `saveTitleCardPng`), so the export only
 * ever sees an image: no dependency on ffmpeg's drawtext, and the preview
 * and the export show the same pixels. Entirely local. */

export interface TitleCardFields {
  title: string;
  subtitle: string;
  bgColor: string;
  textColor: string;
}

export const DEFAULT_TITLE_CARD_COLORS = { bgColor: "#111827", textColor: "#ffffff" };

// The app's own font (`@fontsource-variable/geist`, see styles.css).
const FONT_FAMILY = '"Geist Variable", system-ui, sans-serif';

/** Greedy word wrap of `text` to lines no wider than `maxWidth` in the
 * context's current font. A single word wider than the line keeps its own
 * line rather than being broken mid-word. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws the card onto `canvas` at its current size: the background colour,
 * then the bold title and the smaller subtitle, centred as one block. Sizes
 * are proportional to the height, so a small thumbnail looks like the full
 * render. */
export async function drawTitleCard(canvas: HTMLCanvasElement, fields: TitleCardFields): Promise<void> {
  const { width, height } = canvas;
  const titleSize = Math.max(1, Math.round(height * 0.085));
  const subtitleSize = Math.max(1, Math.round(height * 0.045));
  // Make sure the webfont is loaded, or the first draw silently falls back.
  await Promise.all([
    document.fonts.load(`700 ${titleSize}px ${FONT_FAMILY}`),
    document.fonts.load(`400 ${subtitleSize}px ${FONT_FAMILY}`),
  ]);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available.");

  ctx.fillStyle = fields.bgColor;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = fields.textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const maxWidth = width * 0.84;
  const titleFont = `700 ${titleSize}px ${FONT_FAMILY}`;
  const subtitleFont = `400 ${subtitleSize}px ${FONT_FAMILY}`;
  ctx.font = titleFont;
  const titleLines = wrapLines(ctx, fields.title.trim(), maxWidth);
  ctx.font = subtitleFont;
  const subtitleLines = wrapLines(ctx, fields.subtitle.trim(), maxWidth);

  const titleLineHeight = titleSize * 1.2;
  const subtitleLineHeight = subtitleSize * 1.35;
  const gap = titleLines.length > 0 && subtitleLines.length > 0 ? subtitleSize : 0;
  const blockHeight = titleLines.length * titleLineHeight + gap + subtitleLines.length * subtitleLineHeight;
  let y = (height - blockHeight) / 2;

  ctx.font = titleFont;
  for (const line of titleLines) {
    ctx.fillText(line, width / 2, y + titleLineHeight / 2);
    y += titleLineHeight;
  }
  y += gap;
  ctx.font = subtitleFont;
  ctx.globalAlpha = 0.85;
  for (const line of subtitleLines) {
    ctx.fillText(line, width / 2, y + subtitleLineHeight / 2);
    y += subtitleLineHeight;
  }
  ctx.globalAlpha = 1;
}

/** The card as PNG bytes at `width`x`height`, ready for `saveTitleCardPng`. */
export async function renderTitleCardPng(fields: TitleCardFields, width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  await drawTitleCard(canvas, fields);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not render the title card.");
  return new Uint8Array(await blob.arrayBuffer());
}
