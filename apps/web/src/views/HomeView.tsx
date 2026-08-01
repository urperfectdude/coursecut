// PORTED FROM: src/views/HomeView.tsx @ dad013b
// DEVIATIONS: D7 (no missing-API-key banner — the key is platform-owned)
//
// Desktop is bring-your-own-key, so it warns here when no key is saved and
// offers a shortcut into Settings. The web app supplies the key itself, so
// the condition can never be true and the banner — along with the key check
// that fed it — is gone. The Settings button beside it stays; analysis
// instructions still live there.
// One-way port — desktop is upstream. Don't edit this for web-only reasons;
// port the change to the desktop file first. See docs/web-app-plan.md §7.1,
// and re-run scripts/ui-drift.sh (which reads the SHA above) after syncing.
import { useEffect, useState } from "react";
import { createProject, deleteProject, listProjects, type Project } from "../db";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface HomeViewProps {
  onOpenProject: (id: string) => void;
  onOpenSettings: () => void;
}

export default function HomeView({ onOpenProject, onOpenSettings }: HomeViewProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Which project (if any) is currently pending delete confirmation — a
  // single piece of state rather than one `AlertDialog` per row, since only
  // one confirmation can be open at a time and this keeps the list rendering
  // simple.
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  async function refresh() {
    try {
      const rows = await listProjects();
      setProjects(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      await createProject(name);
      setNewName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteProject(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      {/* `alt=""` on the mark: the heading beside it already reads
          "CourseCut", so naming it again is duplication to a screen reader. */}
      <h1 className="flex items-center gap-2">
        <img src="/icon-192.png" alt="" width={192} height={192} className="size-7" />
        CourseCut
      </h1>

      <form onSubmit={handleCreate} className="my-4 flex gap-2">
        <Label htmlFor="new-project-name" className="sr-only">
          Project name
        </Label>
        <Input
          id="new-project-name"
          type="text"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Project name"
        />
        <Button type="submit" disabled={!newName.trim()}>
          New Project
        </Button>
        <Button type="button" variant="outline" onClick={onOpenSettings}>
          Settings
        </Button>
      </form>

      {/* D7: desktop's missing-API-key banner is deliberately absent. */}

      {error && (
        <Alert variant="destructive" className="my-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <p>Loading projects…</p>
      ) : projects.length === 0 ? (
        <p>No projects yet. Create one to get started.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex items-center justify-between gap-4 border-b border-border py-2"
            >
              <button
                type="button"
                className="flex flex-1 flex-col items-start gap-0.5 border-0 bg-transparent p-0 text-left text-inherit [font:inherit]"
                onClick={() => onOpenProject(project.id)}
              >
                <span className="font-semibold">{project.name}</span>
                <span className="text-sm opacity-70">
                  Updated {new Date(project.updated_at).toLocaleString()}
                </span>
              </button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => setPendingDelete(project)}
                aria-label={`Delete ${project.name}`}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete &&
                `Delete project "${pendingDelete.name}"? This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
