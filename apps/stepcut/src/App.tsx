// Original to apps/stepcut — not a port of the desktop app's `App.tsx`
// (apps/stepcut has no desktop counterpart), so there is no "PORTED FROM"
// header and no `scripts/ui-drift.sh` entry here.
//
// A single `useState<View>` switch, same shape as the pattern apps/web
// carries over from desktop. Three levels now, not two: `home` lists/creates
// the org's projects (`HomeView`); `project`/`templates` are both scoped to
// one project (its videos, and its templates/renders respectively — a
// project keeps its own brand kit, per apps/stepcut-api/src/db/schema.ts's
// `projects` section); `steps` drills one level further, into one video
// inside that project. Every non-`home` view carries the `projectId` it
// needs to fetch and to hand to its own API calls — there is no ambient
// "current project" the way `useOrgs` provides an ambient "current org".
//
// Reads the active org itself (via `useOrgs`, the same hook `AppShell`
// already uses to build the switcher) rather than having `SessionGate`/
// `AppShell` thread it down as a prop — `AppShell`'s `children` stays a
// plain `ReactNode`, and any later view that needs the org can ask the same
// way.

import { useState } from "react";
import { useOrgs } from "@/auth/useOrgs";
import { Button } from "@/components/ui/button";
import HomeView from "./views/HomeView";
import DashboardView from "./views/DashboardView";
import StepsEditorView from "./views/StepsEditorView";
import TemplatesView from "./views/TemplatesView";

type View =
  | { name: "home" }
  | { name: "project"; projectId: string }
  | { name: "templates"; projectId: string }
  | { name: "steps"; projectId: string; videoId: string };

export default function App() {
  const [view, setView] = useState<View>({ name: "home" });
  const orgs = useOrgs(true);
  const activeOrg = orgs.orgs.find((org) => org.id === orgs.activeOrgId);

  return (
    <main className="app-shell">
      {(view.name === "project" || view.name === "templates") && (
        <nav className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-8 pt-4">
          <Button variant="ghost" size="sm" onClick={() => setView({ name: "home" })}>
            ← Home
          </Button>
          <div className="flex gap-2">
            <Button
              variant={view.name === "project" ? "default" : "ghost"}
              size="sm"
              onClick={() => setView({ name: "project", projectId: view.projectId })}
            >
              Videos
            </Button>
            <Button
              variant={view.name === "templates" ? "default" : "ghost"}
              size="sm"
              onClick={() => setView({ name: "templates", projectId: view.projectId })}
            >
              Templates
            </Button>
          </div>
        </nav>
      )}
      {view.name === "home" && (
        <HomeView org={activeOrg} onOpenProject={(projectId) => setView({ name: "project", projectId })} />
      )}
      {view.name === "project" && (
        <DashboardView
          projectId={view.projectId}
          onEditSteps={(videoId) => setView({ name: "steps", projectId: view.projectId, videoId })}
        />
      )}
      {view.name === "templates" && <TemplatesView projectId={view.projectId} />}
      {view.name === "steps" && (
        <StepsEditorView
          projectId={view.projectId}
          videoId={view.videoId}
          onBack={() => setView({ name: "project", projectId: view.projectId })}
        />
      )}
    </main>
  );
}
