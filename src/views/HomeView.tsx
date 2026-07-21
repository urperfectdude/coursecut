import { useEffect, useState } from "react";
import { createProject, deleteProject, getOpenAiKeyStatus, listProjects, type Project } from "../db";

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

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Delete project "${name}"? This cannot be undone.`)) {
      return;
    }
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

      <form onSubmit={handleCreate} className="new-project-form">
        <input
          type="text"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Project name"
          aria-label="Project name"
        />
        <button type="submit" disabled={!newName.trim()}>
          New Project
        </button>
        <button type="button" onClick={onOpenSettings}>
          Settings
        </button>
      </form>

      {keyCheckError ? (
        <div className="key-banner" role="alert">
          <p>Could not check your OpenAI API key status: {keyCheckError}</p>
        </div>
      ) : (
        keyPresent === false && (
          <div className="key-banner" role="alert">
            <p>
              CourseCut is bring-your-own-key: transcription and analysis need an OpenAI API key.
              Nothing will process until one is saved.
            </p>
            <button type="button" onClick={onOpenSettings}>
              Add API key
            </button>
          </div>
        )
      )}

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p>Loading projects…</p>
      ) : projects.length === 0 ? (
        <p>No projects yet. Create one to get started.</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id} className="project-list-item">
              <button
                type="button"
                className="project-link"
                onClick={() => onOpenProject(project.id)}
              >
                <span className="project-name">{project.name}</span>
                <span className="project-updated">
                  Updated {new Date(project.updated_at).toLocaleString()}
                </span>
              </button>
              <button
                type="button"
                className="delete-button"
                onClick={() => handleDelete(project.id, project.name)}
                aria-label={`Delete ${project.name}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
