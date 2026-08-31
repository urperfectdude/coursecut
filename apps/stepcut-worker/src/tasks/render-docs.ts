// Generates the `.md`/`index.html` a `'markdown'`/`'html'`-format render
// produces — see `tasks/render.ts`'s `encodeAndUploadSteps` for the caller
// and `apps/stepcut-api/src/routes/exports-public.ts`'s header for why each
// step's clip has a permanent public URL to embed rather than a presigned
// one. Pure string builders, deliberately: no filesystem, no storage, no
// network — easy to test against plain objects, and the only place either
// document's shape is decided.

export interface RenderDocStep {
  title: string;
  summary: string | null;
  /** The permanent public URL for this step's clip
   * (`routes/exports-public.ts`'s `/api/exports/:renderId/steps/:stepId`). */
  url: string;
}

/**
 * HTML-escapes `text` — the one thing that makes `renderHtmlDoc` safe to
 * serve on an unauthenticated public route (`routes/exports-public.ts`).
 * Every string embedded below is user-authored (a step's title/summary, the
 * video's own name) and reaches this page with no session and no CSP beyond
 * whatever the browser applies by default, so an unescaped `<script>` in a
 * title would be a stored-XSS path onto a page anyone with the link can
 * open. Escaped once, here, rather than trusted at each call site.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A `.md` file listing each step — title, summary, a plain link, **and** an
 * inline `<video controls>` tag. The tag is what makes the clip actually
 * play inline on GitHub and most integrated markdown viewers (raw HTML is
 * valid GFM); the link beside it is the fallback for a renderer that strips
 * embedded HTML instead, so the URL is still reachable either way.
 */
export function renderMarkdownDoc(videoTitle: string, steps: readonly RenderDocStep[]): string {
  const lines: string[] = [`# ${videoTitle}`, ""];

  steps.forEach((step, index) => {
    lines.push(`## ${index + 1}. ${step.title}`, "");
    if (step.summary) lines.push(step.summary, "");
    lines.push(`<video src="${step.url}" controls></video>`, "");
    lines.push(`[Watch this step](${step.url})`, "");
  });

  return lines.join("\n");
}

/**
 * A single static HTML page — one `<section>` per step (title, summary, a
 * playable clip). No client JS and no template logo (kept out of this
 * pass — a logo would need its own public-serving case for one more asset,
 * same reasoning `tasks/render.ts`'s header gives for skipping intro/outro
 * here too). `brandHex` is used only as a heading accent color.
 */
export function renderHtmlDoc(videoTitle: string, brandHex: string, steps: readonly RenderDocStep[]): string {
  const safeBrand = /^#[0-9a-fA-F]{3,8}$/.test(brandHex) ? brandHex : "#000000";
  const title = escapeHtml(videoTitle);

  const sections = steps
    .map(
      (step, index) => `
    <section>
      <h2>${index + 1}. ${escapeHtml(step.title)}</h2>
      ${step.summary ? `<p>${escapeHtml(step.summary)}</p>` : ""}
      <video src="${step.url}" controls playsinline></video>
    </section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { border-bottom: 3px solid ${safeBrand}; padding-bottom: 0.5rem; }
    h2 { color: ${safeBrand}; margin-top: 2.5rem; }
    video { width: 100%; border-radius: 8px; background: #000; }
    section { margin-bottom: 2rem; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${sections}
</body>
</html>
`;
}
