import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  getProject,
  importVideos,
  listVideos,
  SUPPORTED_VIDEO_EXTENSIONS,
  type Project,
  type Video,
} from "../db";

interface ProjectDetailViewProps {
  projectId: string;
  onBack: () => void;
}

/** Last path component, handling both `/` (macOS) and `\` (Windows). */
function basename(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index === -1 ? path : path.slice(index + 1);
}

/** Seconds → `m:ss` / `h:mm:ss`. Duration is probed later, so most rows
 * show the `--:--` placeholder for now. */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return "--:--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${m}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : mmss;
}

export default function ProjectDetailView({ projectId, onBack }: ProjectDetailViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mirrors `importing` for the drag-drop listener and button handlers,
  // which would otherwise close over a stale value — one import at a time.
  const importingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getProject(projectId), listVideos(projectId)])
      .then(([projectRow, videoRows]) => {
        if (cancelled) return;
        setProject(projectRow);
        setVideos(videoRows);
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

  const handleImport = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      try {
        const added = await importVideos(projectId, paths);
        setImportMessage(
          added.length === 0
            ? "No new supported videos found."
            : `Imported ${added.length} video${added.length === 1 ? "" : "s"}.`,
        );
        setVideos(await listVideos(projectId));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [projectId],
  );

  // Tauri delivers OS drag & drop through the webview event, not DOM events.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          void handleImport(event.payload.paths);
        } else {
          setDragging(false);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleImport]);

  async function handleImportFiles() {
    try {
      const selection = await open({
        multiple: true,
        filters: [{ name: "Videos", extensions: SUPPORTED_VIDEO_EXTENSIONS }],
      });
      if (selection) await handleImport(selection);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleImportFolder() {
    try {
      const selection = await open({ directory: true });
      if (selection) await handleImport([selection]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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

          <div className="import-actions">
            <button type="button" onClick={handleImportFiles} disabled={importing}>
              Import videos
            </button>
            <button type="button" onClick={handleImportFolder} disabled={importing}>
              Import folder
            </button>
            {importing && <span className="import-status">Importing…</span>}
          </div>

          <div className={dragging ? "drop-zone drop-zone-active" : "drop-zone"}>
            {dragging ? "Drop to import" : "Or drag & drop video files or folders here"}
          </div>

          {importMessage && <p className="import-message">{importMessage}</p>}

          {videos.length === 0 ? (
            <p>No videos imported yet.</p>
          ) : (
            <ul className="video-list">
              {videos.map((video) => (
                <li key={video.id} className="video-list-item">
                  <div className="video-info">
                    <span className="video-name">{basename(video.file_path)}</span>
                    <span className="video-path">{video.file_path}</span>
                  </div>
                  <span className="video-duration">{formatDuration(video.duration)}</span>
                  <span className={`status-badge status-${video.transcript_status}`}>
                    {video.transcript_status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
