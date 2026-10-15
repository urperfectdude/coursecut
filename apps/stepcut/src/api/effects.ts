// Typed wrappers over `apps/stepcut-api`'s zoom/speed region routes
// (`routes/effects.ts`).

import { request } from "./http";
import type { Job } from "./videos";

export interface ZoomRegion {
  id: string;
  video_id: string;
  start: number;
  end: number;
  scale: number;
  focus_x: number;
  focus_y: number;
  /** `"suggested"` until someone accepts it — only `"manual"` zooms render. */
  source: "manual" | "suggested";
  updated_at: string;
}

export interface SpeedRegion {
  id: string;
  video_id: string;
  start: number;
  end: number;
  rate: number;
  updated_at: string;
}

export interface VideoEffects {
  zooms: ZoomRegion[];
  speeds: SpeedRegion[];
}

type ZoomFields = Pick<ZoomRegion, "start" | "end" | "scale" | "focus_x" | "focus_y">;
type SpeedFields = Pick<SpeedRegion, "start" | "end" | "rate">;

export function getEffects(videoId: string): Promise<VideoEffects> {
  return request<VideoEffects>("GET", `/videos/${videoId}/effects`);
}

export function addZoom(videoId: string, zoom: ZoomFields): Promise<ZoomRegion> {
  return request<ZoomRegion>("POST", `/videos/${videoId}/zooms`, zoom);
}

/** An empty patch accepts a suggestion as-is. */
export function updateZoom(id: string, patch: Partial<ZoomFields>): Promise<ZoomRegion> {
  return request<ZoomRegion>("PATCH", `/zooms/${id}`, patch);
}

export function deleteZoom(id: string): Promise<void> {
  return request<void>("DELETE", `/zooms/${id}`);
}

/** Queues the `zooms` job; poll `getJobs` for `kind === "zooms"`. */
export function suggestZooms(videoId: string): Promise<Job> {
  return request<Job>("POST", `/videos/${videoId}/zooms/suggest`);
}

export function dismissZoomSuggestions(videoId: string): Promise<void> {
  return request<void>("DELETE", `/videos/${videoId}/zooms/suggestions`);
}

export function addSpeed(videoId: string, speed: SpeedFields): Promise<SpeedRegion> {
  return request<SpeedRegion>("POST", `/videos/${videoId}/speeds`, speed);
}

export function updateSpeed(id: string, patch: Partial<SpeedFields>): Promise<SpeedRegion> {
  return request<SpeedRegion>("PATCH", `/speeds/${id}`, patch);
}

export function deleteSpeed(id: string): Promise<void> {
  return request<void>("DELETE", `/speeds/${id}`);
}
