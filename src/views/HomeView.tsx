import { useEffect, useState } from "react";
import { createProject, deleteProject, getOpenAiKeyStatus, listProjects, type Project } from "../db";
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
  // BYOK: CourseCut has no key of its own, so a missing key is a persistent
  // banner rather than a dismissible toast (PRD "Phase 1 — API key
  // onboarding"). `null` = not checked yet, so the banner doesn't flash on
  // first paint before the async check resolves.
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);
  // Distinct from "checked and no key found" — a thrown error here usually
  // means the OS keychain itself is inaccessible (locked, permission
  // denied), in which case routing the user into Settings to "add a key"
  // would likely just fail the same way. Kept separate so that case gets
  // its own message instead of being presented as a plain missing-key banner.
  const [keyCheckError, setKeyCheckError] = useState<string | null>(null);
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
    // HomeView unmounts whenever `App.tsx` navigates away (it's only
    // rendered when `view.name === "home"`), so this re-runs on every
    // return from Settings — no separate focus/refetch trigger needed for
    // the banner to clear after a key is saved.
    getOpenAiKeyStatus()
      .then((status) => setKeyPresent(status.present))
      .catch((err) =>
        setKeyCheckError(err instanceof Error ? err.message : String(err)),
      );
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
      <h1>CourseCut</h1>

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

      {keyCheckError ? (
        <Alert className="my-4 border-amber-600/40 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertDescription className="text-inherit">
            Could not check your OpenAI API key status: {keyCheckError}
          </AlertDescription>
        </Alert>
      ) : (
        keyPresent === false && (
          <Alert className="my-4 flex items-center justify-between gap-4 border-amber-600/40 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertDescription className="text-inherit">
              CourseCut is bring-your-own-key: transcription and analysis need an OpenAI API key.
              Nothing will process until one is saved.
            </AlertDescription>
            <Button type="button" onClick={onOpenSettings}>
              Add API key
            </Button>
          </Alert>
        )
      )}

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
