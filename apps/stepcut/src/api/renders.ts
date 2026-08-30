// Typed wrappers over `apps/stepcut-api`'s Phase 5 render routes
// (docs/stepcut-plan.md §8: "Templates & render"), this slice.
//
// Two response shapes, not one, because the API's own `routes/renders.ts`
// returns two different things depending on the route:
//
//  * `serialize.render` (`http/serialize.ts`) is the wire shape every render
//    route returns *except* `GET /renders/:id` — `RenderSummary` below.
//  * `GET /renders/:id` alone adds a freshly-presigned `output_url`, `null`
//    until the render is `done` (`routes/renders.ts`'s own comment) — `Render`
//    below, `RenderSummary` plus that one field.
//
// `createRender` mirrors `analyzeVideo`'s doc comment in `./videos.ts`:
// `POST /renders` only ever returns `202 { id, status }`
// (`routes/renders.ts`), so a caller must poll `getRender` for everything
// else — same "don't trust the initial response" rule, reused here rather
// than reinvented.

import { request } from "./http";

/** The wire shape `serialize.render` produces — everything a render route
 * returns except `GET /renders/:id`'s extra `output_url`. */
export interface RenderSummary {
  id: string;
  video_id: string;
  template_id: string;
  status: string;
  progress: number | null;
  error: string | null;
  callback_url: string | null;
  size_bytes: number | null;
  webhook_status: string | null;
  webhook_attempts: number;
  created_at: string;
  updated_at: string;
}

/** `GET /renders/:id`'s shape: `RenderSummary` plus a freshly-minted
 * `output_url`, `null` until the render is `done`. Never cached — a caller
 * that needs a download link should re-fetch this rather than reuse an
 * old value, since the URL is presigned and short-lived (plan §6). */
export interface Render extends RenderSummary {
  output_url: string | null;
}

/** What `POST /renders` actually returns per `routes/renders.ts` — just
 * enough to start polling `getRender`, not the full render shape. */
export interface CreatedRender {
  id: string;
  status: string;
}

export function createRender(
  videoId: string,
  templateId: string,
  callbackUrl?: string,
): Promise<CreatedRender> {
  return request<CreatedRender>("POST", "/renders", {
    video_id: videoId,
    template_id: templateId,
    callback_url: callbackUrl,
  });
}

export function getRender(id: string): Promise<Render> {
  return request<Render>("GET", `/renders/${id}`);
}

export function cancelRender(id: string): Promise<RenderSummary> {
  return request<RenderSummary>("POST", `/renders/${id}/cancel`);
}

/** A video's renders, newest first. */
export function listRendersForVideo(videoId: string): Promise<RenderSummary[]> {
  return request<RenderSummary[]>("GET", `/videos/${videoId}/renders`);
}
