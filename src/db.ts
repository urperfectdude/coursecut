import { invoke } from "@tauri-apps/api/core";

// Design note: coursecut queries SQLite from Rust only (see
// `src-tauri/src/db.rs`), invoked here over IPC via `invoke()`. The
// frontend has no direct SQL surface — there's no `@tauri-apps/plugin-sql`
// dependency, and no `sql:*` permissions in
// `src-tauri/capabilities/default.json`.

export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Video {
  id: string;
  project_id: string;
  file_path: string;
  duration: number | null;
  transcript_status: string;
  created_at: string;
  updated_at: string;
}

// Keep in sync with `SUPPORTED_EXTENSIONS` in `src-tauri/src/db.rs` —
// Rust is the enforcing side; this copy only feeds file-dialog filters.
export const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "m4v"];

export async function createProject(name: string): Promise<Project> {
  return invoke<Project>("create_project", { name });
}

export async function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("list_projects");
}

export async function getProject(id: string): Promise<Project | null> {
  // Rust resolves to `null` when no project matches `id` and only rejects
  // on a real error, so a not-found and a genuine failure aren't conflated.
  return invoke<Project | null>("get_project", { id });
}

export async function importVideos(projectId: string, paths: string[]): Promise<Video[]> {
  // Rust walks the paths (recursing into folders), skips unsupported /
  // already-imported files, and returns only the newly created rows.
  // Source files stay where they are — import never copies or moves them.
  return invoke<Video[]>("import_videos", { projectId, paths });
}

export async function listVideos(projectId: string): Promise<Video[]> {
  return invoke<Video[]>("list_videos", { projectId });
}

export async function deleteProject(id: string): Promise<void> {
  // Cascade delete of videos/lessons/etc. is handled by the schema's
  // ON DELETE CASCADE (see 0001_init.sql) — no app-level cascade needed.
  await invoke("delete_project", { id });
}
