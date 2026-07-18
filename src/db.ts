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

export async function deleteProject(id: string): Promise<void> {
  // Cascade delete of videos/lessons/etc. is handled by the schema's
  // ON DELETE CASCADE (see 0001_init.sql) — no app-level cascade needed.
  await invoke("delete_project", { id });
}
