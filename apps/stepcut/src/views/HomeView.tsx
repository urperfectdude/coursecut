// The signed-in landing screen — lists an org's projects and creates new
// ones. Sits above `DashboardView`/`TemplatesView`, which are now both
// scoped to one project rather than to the whole org: everything
// project-specific (videos, templates, renders) lives inside a project from
// here on, and this is where a project is created in the first place.
//
// Modeled on `TemplatesView`'s list/create-by-name shape rather than
// introducing a new one.

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { OrgSummary } from "@/auth/useOrgs";
import { createProject, listProjects, type Project } from "@/api/projects";

interface HomeViewProps {
  org: OrgSummary | undefined;
  onOpenProject: (projectId: string) => void;
}

export default function HomeView({ org, onOpenProject }: HomeViewProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const project = await createProject(trimmed);
      setProjects((current) => [project, ...current]);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
      <div>
        <h1 className="text-lg font-semibold">{org?.name ?? "Your organization"}</h1>
        <p className="text-sm text-muted-foreground">
          A project holds a set of videos, their steps, and the templates used to render them.
        </p>
      </div>

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
          placeholder="Project name"
          disabled={creating}
        />
        <Button type="submit" disabled={creating || name.trim().length === 0}>
          {creating ? "Creating…" : "Create project"}
        </Button>
      </form>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No projects yet — create one above to start uploading videos.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((project) => (
            <Card
              key={project.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpenProject(project.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onOpenProject(project.id);
              }}
              className="cursor-pointer transition-colors hover:bg-muted/50"
            >
              <CardHeader>
                <CardTitle>{project.name}</CardTitle>
                <CardDescription>
                  Created {new Date(project.created_at).toLocaleDateString()}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" size="sm" onClick={() => onOpenProject(project.id)}>
                  Open
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
