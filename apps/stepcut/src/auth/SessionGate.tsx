// The route gate: sessions are httpOnly cookies sent automatically by
// `fetch`, with a `useSession` hook local to `apps/stepcut/src/auth/` gating
// everything below it. No view below `children` ever sees auth state.
//
// Simplified from apps/web/src/auth/SessionGate.tsx per the plan's design
// decision 11: no mock-mode branch (apps/stepcut has no desktop counterpart
// that needs a standalone-in-browser fallback, so there is always a real
// `apps/stepcut-api` to talk to) and no invitation-accept flow (nothing sends
// invitations in Phase 1). The core branch order is unchanged: pending →
// splash; no session → `AuthScreen`; zero orgs → `CreateOrgScreen`; else →
// `AppShell`.

import { useCallback, useEffect } from "react";
import { setUnauthorizedHandler } from "@/api/http";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import AppShell from "./AppShell";
import AuthScreen from "./AuthScreen";
import CreateOrgScreen from "./CreateOrgScreen";
import { signOut, useSession } from "./client";
import { useOrgs } from "./useOrgs";

function Splash({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export default function SessionGate({ children }: { children: React.ReactNode }) {
  const { data: session, isPending, refetch } = useSession();

  // Org data only makes sense once there is a session.
  const orgs = useOrgs(Boolean(session));

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  // An expired or revoked session shows up as a 401 from a data call made
  // below this gate, not from anything here — so `api/http`'s transport
  // reports it and the gate re-reads the session, which drops the user on
  // the sign-in screen instead of leaving every view rendering "Unauthorized".
  useEffect(() => {
    setUnauthorizedHandler(refresh);
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  if (isPending) return <Splash message="Loading…" />;

  if (!session) {
    return <AuthScreen onAuthenticated={refresh} />;
  }

  if (orgs.loading) return <Splash message="Loading…" />;

  if (orgs.error) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6">
        <Alert variant="destructive" className="max-w-md">
          <AlertDescription>{orgs.error}</AlertDescription>
        </Alert>
        <div className="flex gap-2">
          <Button type="button" onClick={() => void orgs.refresh()}>
            Try again
          </Button>
          <Button type="button" variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  if (orgs.orgs.length === 0) {
    return <CreateOrgScreen onCreated={() => void orgs.refresh()} />;
  }

  return (
    <AppShell user={session.user} orgs={orgs} onSessionChanged={refresh}>
      {children}
    </AppShell>
  );
}
