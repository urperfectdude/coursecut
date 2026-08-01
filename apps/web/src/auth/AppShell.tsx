// The only chrome the web app adds around the copied desktop UI (plan §4.1).
//
// It is deliberately thin. `HomeView`, `SettingsView` and the rest are copied
// files that §7.1 forbids editing for web-only reasons, so everything
// multi-tenancy needs — which org you are in, who you are signed in as — has
// to live *above* them. What lands on screen is one muted row: an org switcher
// that renders only for a user who belongs to more than one org (§4.1's rule,
// so a single-org user sees the desktop app with a name in the corner), and
// two buttons that open dialogs.
//
// **Switching orgs remounts the view tree.** `children` is keyed by the active
// org id, so every copied view unmounts and refetches, and the app returns to
// its home view. The alternative — leaving the views mounted with the previous
// tenant's rows in `useState` while the server has moved on — would render one
// org's data under another org's name, which is the one thing a multi-tenant
// UI must never do. A full page reload would also work; this keeps the SPA
// alive and is a one-line guarantee rather than a habit.

import { Fragment, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AccountDialog from "./AccountDialog";
import MembersDialog from "./MembersDialog";
import UsageDialog from "./UsageDialog";
import { authErrorMessage, organization } from "./client";
import type { OrgsState } from "./useOrgs";

interface AppShellProps {
  user: { id: string; name: string; email: string };
  orgs: OrgsState;
  /** Re-reads the session, so a renamed user updates the bar. */
  onSessionChanged: () => void;
  children: React.ReactNode;
}

export default function AppShell({ user, orgs, onSessionChanged, children }: AppShellProps) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeOrg = orgs.orgs.find((org) => org.id === orgs.activeOrgId);

  async function handleSwitch(organizationId: string) {
    if (organizationId === orgs.activeOrgId) return;
    setSwitching(true);
    setError(null);
    // Through `better-auth`, never through our own API: the session column it
    // writes is the single value RLS keys on, and it stays single-writer
    // (see apps/api/src/routes/orgs.ts).
    const { error: switchError } = await organization.setActive({ organizationId });
    if (switchError) setError(authErrorMessage(switchError));
    await orgs.refresh();
    setSwitching(false);
  }

  return (
    <>
      <div className="flex items-center justify-end gap-2 px-8 pt-4">
        {orgs.orgs.length > 1 && (
          <Select
            value={orgs.activeOrgId ?? undefined}
            onValueChange={(value) => void handleSwitch(value)}
            disabled={switching}
          >
            <SelectTrigger size="sm" className="w-56" aria-label="Active organization">
              <SelectValue placeholder="Organization" />
            </SelectTrigger>
            <SelectContent>
              {orgs.orgs.map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button type="button" variant="ghost" size="sm" onClick={() => setUsageOpen(true)}>
          Usage
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setMembersOpen(true)}>
          Members
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setAccountOpen(true)}>
          {user.name || user.email}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mx-8 mt-2 w-auto">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Fragment key={orgs.activeOrgId ?? "none"}>{children}</Fragment>

      <AccountDialog
        open={accountOpen}
        onOpenChange={setAccountOpen}
        user={user}
        onUpdated={onSessionChanged}
      />
      <MembersDialog
        open={membersOpen}
        onOpenChange={setMembersOpen}
        orgName={activeOrg?.name ?? ""}
        role={orgs.role}
        currentUserId={user.id}
      />
      <UsageDialog
        open={usageOpen}
        onOpenChange={setUsageOpen}
        orgId={orgs.activeOrgId ?? ""}
        orgName={activeOrg?.name ?? ""}
        role={orgs.role}
        // Deleting the active org leaves the session pointing at something
        // that no longer exists; `requireOrg` adopts the oldest remaining
        // membership on the next request (M3's fallback), and re-reading the
        // list is what makes the switcher and the remounted view tree agree
        // with it. A user whose last org this was lands on "create an
        // organization", which is where the gate puts an org-less account.
        onOrgDeleted={() => void orgs.refresh()}
      />
    </>
  );
}
