// Original to apps/stepcut — not a port of the desktop app's `App.tsx`
// (apps/stepcut has no desktop counterpart), so there is no "PORTED FROM"
// header and no `scripts/ui-drift.sh` entry here.
//
// A single `useState<View>` switch, same shape as the pattern apps/web
// carries over from desktop, with exactly one view for Phase 1.
//
// Reads the active org itself (via `useOrgs`, the same hook `AppShell`
// already uses to build the switcher) rather than having `SessionGate`/
// `AppShell` thread it down as a prop — `AppShell`'s `children` stays a
// plain `ReactNode`, and any later view that needs the org can ask the same
// way.

import { useState } from "react";
import { useOrgs } from "@/auth/useOrgs";
import DashboardView from "./views/DashboardView";

type View = { name: "dashboard" };

export default function App() {
  const [view] = useState<View>({ name: "dashboard" });
  const orgs = useOrgs(true);
  const activeOrg = orgs.orgs.find((org) => org.id === orgs.activeOrgId);

  return (
    <main className="app-shell">
      {view.name === "dashboard" && <DashboardView org={activeOrg} />}
    </main>
  );
}
