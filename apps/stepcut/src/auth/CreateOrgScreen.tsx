// The terminal state for a session that belongs to no organization.
//
// `apps/stepcut-api`'s `requireOrg` 403s such a caller rather than letting
// RLS return empty rows that look like data loss, so the SPA has to render
// *something* here — and the only honest something is a way out.
//
// Adapted from apps/web/src/auth/CreateOrgScreen.tsx — own wording, no
// `notice` prop (that exists on the source file only to explain a failed
// invitation, and apps/stepcut has no invitation flow in Phase 1 — see
// `SessionGate.tsx`'s header). The manual-create flow itself is unchanged.

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createOrganization, signOut } from "./client";

interface CreateOrgScreenProps {
  onCreated: () => void;
}

export default function CreateOrgScreen({ onCreated }: CreateOrgScreenProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createOrganization(name);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Create an organization</CardTitle>
          <CardDescription>
            Recordings and tutorials belong to an organization. Create one to get started, or ask
            a colleague to invite you to theirs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="create-org-name">Organization name</Label>
              <Input
                id="create-org-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Acme University"
                required
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create organization"}
            </Button>
          </form>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-4 h-auto p-0"
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
