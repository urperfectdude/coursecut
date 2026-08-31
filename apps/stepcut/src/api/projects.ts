// Typed wrappers over `apps/stepcut-api`'s project routes — the grouping
// unit the Home screen lists and creates. Modeled on `api/templates.ts`'s
// shape (list/create/rename, no delete yet).

import { request } from "./http";

export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export function listProjects(): Promise<Project[]> {
  return request<Project[]>("GET", "/projects");
}

export function getProject(id: string): Promise<Project> {
  return request<Project>("GET", `/projects/${id}`);
}

export function createProject(name: string): Promise<Project> {
  return request<Project>("POST", "/projects", { name });
}

export function renameProject(id: string, name: string): Promise<Project> {
  return request<Project>("PATCH", `/projects/${id}`, { name });
}
