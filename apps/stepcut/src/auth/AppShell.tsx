// The chrome around whatever `App.tsx` renders below it.
//
// Trimmed from apps/web/src/auth/AppShell.tsx per the plan: keeps the org
// switcher (only rendered when there's more than one org to switch between)
// and a sign-out button. Drops `AccountDialog`/`MembersDialog`/`UsageDialog`
// and everything that opens them — nothing to manage yet in Phase 1.
//
// **Switching orgs remounts the view tree.** `children` is keyed by the
// active org id, so any future view unmounts and refetches rather than
// rendering one org's data under another org's name — the one thing a
// multi-tenant UI must never do.

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
import { authErrorMessage, organization, signOut } from "./client";
import type { OrgsState } from "./useOrgs";

interface AppShellProps {
  user: { id: string; name: string; email: string };
  orgs: OrgsState;
  /** Re-reads the session, so a renamed user updates the bar. Unused today
   * (there's no dialog that renames a user yet), kept so the signature
   * matches what `SessionGate` already passes. */
  onSessionChanged: () => void;
  children: React.ReactNode;
}

export default function AppShell({ user, orgs, children }: AppShellProps) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSwitch(organizationId: string) {
    if (organizationId === orgs.activeOrgId) return;
    setSwitching(true);
    setError(null);
    // Through `better-auth`, never through our own API: the session column it
    // writes is the single value RLS keys on, and it stays single-writer.
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

        <span className="text-sm text-muted-foreground">{user.name || user.email}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mx-8 mt-2 w-auto">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Fragment key={orgs.activeOrgId ?? "none"}>{children}</Fragment>
    </>
  );
}
