// The route gate (plan §4.1): "Sessions are httpOnly cookies sent
// automatically by `fetch`, with a `useSession` hook local to
// `apps/web/src/auth/` gating routes above the view tree. No copied view ever
// sees auth state."
//
// This is that gate, and the whole auth surface hangs off it. Everything below
// `children` is the desktop app, unaware that any of this exists — which is
// what keeps `db.ts`'s exported surface a match for desktop's and `ui-drift.sh`
// meaningful.
//
// In mock mode there is no API and therefore no session to have, so the gate
// steps aside entirely: `VITE_API_MODE` unset still gives the M1 experience of
// a clickable UI with nothing running (plan §5).

import { useCallback, useEffect, useRef, useState } from "react";
import { isMockMode, setUnauthorizedHandler } from "../api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import AppShell from "./AppShell";
import AuthScreen from "./AuthScreen";
import CreateOrgScreen from "./CreateOrgScreen";
import { authErrorMessage, organization, signOut, useSession } from "./client";
import { clearInvitationParam, readInvitationId } from "./invitation";
import { useOrgs } from "./useOrgs";

export default function SessionGate({ children }: { children: React.ReactNode }) {
  // A build-time constant, so this branch never changes across renders and
  // the two subtrees never share hook state.
  if (isMockMode) return <>{children}</>;
  return <LiveGate>{children}</LiveGate>;
}

function Splash({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function LiveGate({ children }: { children: React.ReactNode }) {
  const { data: session, isPending, refetch } = useSession();
  const [invitationId, setInvitationId] = useState<string | null>(readInvitationId);
  const [invitationNotice, setInvitationNotice] = useState<string | null>(null);
  // One attempt per invitation id. `session` changes identity on every
  // refetch, and accepting twice is a guaranteed error the second time.
  const acceptedRef = useRef<string | null>(null);

  // Org data only makes sense once there is a session and no invitation still
  // to be applied — asking before that would 403 and then immediately be stale.
  const orgs = useOrgs(Boolean(session) && invitationId === null);

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  // An expired or revoked session shows up as a 401 from a copied view's own
  // data call, not from anything here — so `db.ts`'s transport reports it and
  // the gate re-reads the session, which drops the user on the sign-in screen
  // instead of leaving every view rendering "Unauthorized".
  useEffect(() => {
    setUnauthorizedHandler(refresh);
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  useEffect(() => {
    if (!session || !invitationId || acceptedRef.current === invitationId) return;
    acceptedRef.current = invitationId;
    void (async () => {
      const { data, error } = await organization.acceptInvitation({ invitationId });
      // Cleared either way: a refused invitation retried on every reload is
      // just a loop, and the reason is reported below instead.
      clearInvitationParam();
      if (error) {
        setInvitationNotice(`That invitation could not be accepted: ${authErrorMessage(error)}`);
      } else if (data?.invitation?.organizationId) {
        await organization.setActive({ organizationId: data.invitation.organizationId });
      }
      setInvitationId(null);
    })();
  }, [session, invitationId]);

  if (isPending) return <Splash message="Loading…" />;

  if (!session) {
    return <AuthScreen hasPendingInvitation={invitationId !== null} onAuthenticated={refresh} />;
  }

  if (invitationId) return <Splash message="Joining organization…" />;

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
    return <CreateOrgScreen notice={invitationNotice} onCreated={() => void orgs.refresh()} />;
  }

  return (
    <AppShell user={session.user} orgs={orgs} onSessionChanged={refresh}>
      {children}
    </AppShell>
  );
}
