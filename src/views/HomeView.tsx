import { useEffect, useState } from "react";
import { createProject, deleteProject, listProjects, type Project } from "../db";

interface HomeViewProps {
  onOpenProject: (id: string) => void;
}

export default function HomeView({ onOpenProject }: HomeViewProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      </form>

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
