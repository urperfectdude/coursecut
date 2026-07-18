import { useEffect, useState } from "react";
import { getProject, type Project } from "../db";

interface ProjectDetailViewProps {
  projectId: string;
  onBack: () => void;
}

export default function ProjectDetailView({ projectId, onBack }: ProjectDetailViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getProject(projectId)
      .then((row) => {
        if (!cancelled) setProject(row);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div>
      <button type="button" className="back-button" onClick={onBack}>
        ← Back to projects
      </button>

      {loading && <p>Loading project…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && !project && <p>Project not found.</p>}

      {project && (
        <>
          <h1>{project.name}</h1>
          <p>
            Created {new Date(project.created_at).toLocaleString()} · Updated{" "}
            {new Date(project.updated_at).toLocaleString()}
          </p>
          <p>Video import and editing aren't built yet — this is just the project shell.</p>
        </>
      )}
    </div>
  );
}
