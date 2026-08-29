// Original to apps/stepcut — not a port of the desktop app's `App.tsx`
// (apps/stepcut has no desktop counterpart), so there is no "PORTED FROM"
// header and no `scripts/ui-drift.sh` entry here.
//
// A single `useState<View>` switch, same shape as the pattern apps/web
// carries over from desktop. Phase 4 (docs/stepcut-plan.md §8: "Manual
// editing") adds a second view — `StepsEditorView`, reached from a video's
// row in the dashboard — alongside Phase 1's `dashboard`.
//
// Reads the active org itself (via `useOrgs`, the same hook `AppShell`
// already uses to build the switcher) rather than having `SessionGate`/
// `AppShell` thread it down as a prop — `AppShell`'s `children` stays a
// plain `ReactNode`, and any later view that needs the org can ask the same
// way.

import { useState } from "react";
import { useOrgs } from "@/auth/useOrgs";
import DashboardView from "./views/DashboardView";
import StepsEditorView from "./views/StepsEditorView";

type View = { name: "dashboard" } | { name: "steps"; videoId: string };

export default function App() {
  const [view, setView] = useState<View>({ name: "dashboard" });
  const orgs = useOrgs(true);
  const activeOrg = orgs.orgs.find((org) => org.id === orgs.activeOrgId);

  return (
    <main className="app-shell">
      {view.name === "dashboard" && (
        <DashboardView org={activeOrg} onEditSteps={(videoId) => setView({ name: "steps", videoId })} />
      )}
      {view.name === "steps" && (
        <StepsEditorView videoId={view.videoId} onBack={() => setView({ name: "dashboard" })} />
      )}
    </main>
  );
}
