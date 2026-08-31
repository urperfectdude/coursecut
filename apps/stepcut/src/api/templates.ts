// Typed wrappers over `apps/stepcut-api`'s Phase 5 template routes
// (docs/stepcut-plan.md §8: "Templates & render"), slice 1.
//
// `uploadTemplateAsset` mirrors `uploadVideo`'s single-shot path in
// `apps/stepcut/src/api/videos.ts`: mint a presigned PUT, put the bytes
// straight to storage, then confirm. No multipart branch here — a
// template's intro/outro/logo asset is never big enough to need one.

import { putToStorage, request } from "./http";

export interface Template {
  id: string;
  project_id: string;
  name: string;
  intro_key: string | null;
  outro_key: string | null;
  logo_key: string | null;
  brand_primary_hex: string | null;
  brand_secondary_hex: string | null;
  target_width: number;
  target_height: number;
  target_fps: number;
  created_at: string;
  updated_at: string;
}

export type TemplateAssetKind = "intro" | "outro" | "logo";

interface TemplateInput {
  project_id: string;
  name: string;
  brand_primary_hex?: string;
  brand_secondary_hex?: string;
  target_width?: number;
  target_height?: number;
  target_fps?: number;
}

type TemplatePatch = Partial<Omit<TemplateInput, "project_id">>;

interface AssetUploadTicket {
  url: string;
  storage_key: string;
}

export function listTemplates(projectId: string): Promise<Template[]> {
  return request<Template[]>("GET", `/templates?project_id=${encodeURIComponent(projectId)}`);
}

export function getTemplate(id: string): Promise<Template> {
  return request<Template>("GET", `/templates/${id}`);
}

export function createTemplate(input: TemplateInput): Promise<Template> {
  return request<Template>("POST", "/templates", input);
}

export function updateTemplate(id: string, patch: TemplatePatch): Promise<Template> {
  return request<Template>("PATCH", `/templates/${id}`, patch);
}

export function deleteTemplate(id: string): Promise<void> {
  return request<void>("DELETE", `/templates/${id}`);
}

/**
 * Uploads `file` as a template's intro/outro/logo asset: mints a presigned
 * PUT, puts the bytes straight to storage, then confirms — returning the
 * template row with that asset's key now set.
 */
export async function uploadTemplateAsset(
  templateId: string,
  kind: TemplateAssetKind,
  file: File,
): Promise<Template> {
  const contentType = file.type || "application/octet-stream";
  const ticket = await request<AssetUploadTicket>("POST", `/templates/${templateId}/assets/${kind}/uploads`, {
    filename: file.name,
    content_type: contentType,
  });

  await putToStorage(ticket.url, file, contentType);

  return request<Template>("POST", `/templates/${templateId}/assets/${kind}/complete`, {
    storage_key: ticket.storage_key,
  });
}
