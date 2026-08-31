// Minimal templates screen — Phase 5 (docs/stepcut-plan.md §8: "Templates &
// render"), slice 1: list + create-by-name + per-template asset upload. The
// richer render-triggering UI (picking a template, watching a render's
// progress) is a later slice of this same phase.
//
// No coursecut counterpart: apps/stepcut's views are original, not ported
// from desktop. Modeled on `DashboardView`'s list/upload shape rather than
// introducing a new one.

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getProject, type Project } from "@/api/projects";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  uploadTemplateAsset,
  type Template,
  type TemplateAssetKind,
} from "@/api/templates";

interface TemplatesViewProps {
  projectId: string;
}

const ASSET_KINDS: Array<{ kind: TemplateAssetKind; label: string }> = [
  { kind: "intro", label: "Intro" },
  { kind: "outro", label: "Outro" },
  { kind: "logo", label: "Logo" },
];

function assetKeyOf(template: Template, kind: TemplateAssetKind): string | null {
  if (kind === "intro") return template.intro_key;
  if (kind === "outro") return template.outro_key;
  return template.logo_key;
}

export default function TemplatesView({ projectId }: TemplatesViewProps) {
  const [project, setProject] = useState<Project | undefined>(undefined);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // Which `{templateId}:{kind}` upload is in flight, so only that row's
  // button shows a busy state.
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    void getProject(projectId).then(setProject);
  }, [projectId]);

  const refresh = useCallback(async () => {
    try {
      setTemplates(await listTemplates(projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const template = await createTemplate({ project_id: projectId, name: trimmed });
      setTemplates((current) => [template, ...current]);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteTemplate(id);
      setTemplates((current) => current.filter((template) => template.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAssetChosen = async (templateId: string, kind: TemplateAssetKind, file: File) => {
    const key = `${templateId}:${kind}`;
    setUploadingKey(key);
    setError(null);
    try {
      const updated = await uploadTemplateAsset(templateId, kind, file);
      setTemplates((current) => current.map((template) => (template.id === templateId ? updated : template)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingKey((current) => (current === key ? null : current));
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-8">
      <Card>
        <CardHeader>
          <CardTitle>{project?.name ?? "Project"} — templates</CardTitle>
          <CardDescription>
            A template holds an intro, outro, logo, and brand colors a render can reuse. Triggering a
            render from a template comes in a later phase.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Template name"
              disabled={creating}
            />
            <Button type="submit" disabled={creating || name.trim().length === 0}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </form>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No templates yet — create one above.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {templates.map((template) => (
                <li key={template.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{template.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {template.target_width}×{template.target_height} @{template.target_fps}fps
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {ASSET_KINDS.map(({ kind, label }) => {
                      const key = `${template.id}:${kind}`;
                      const hasAsset = assetKeyOf(template, kind) !== null;
                      return (
                        <span key={kind} className="flex items-center gap-1">
                          <Badge variant={hasAsset ? "default" : "outline"}>{label}</Badge>
                          <input
                            ref={(node) => {
                              fileInputRefs.current[key] = node;
                            }}
                            type="file"
                            className="hidden"
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void handleAssetChosen(template.id, kind, file);
                            }}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={uploadingKey === key}
                            onClick={() => fileInputRefs.current[key]?.click()}
                          >
                            {uploadingKey === key ? "Uploading…" : hasAsset ? "Replace" : "Upload"}
                          </Button>
                        </span>
                      );
                    })}
                  </div>

                  <div className="mt-2">
                    <Button variant="ghost" size="sm" onClick={() => void handleDelete(template.id)}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
