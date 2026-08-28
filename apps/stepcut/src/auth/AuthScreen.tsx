// Sign in / sign up — a surface with no desktop counterpart, since StepCut
// has no desktop app at all.
//
// Adapted from apps/web/src/auth/AuthScreen.tsx, simplified per the plan's
// design decision 11 (no mock mode, no invitation flow) and the fact that
// `apps/stepcut-api` doesn't expose password reset yet (no `mail.ts`,
// no `GET /api/config` — see that file's header): the "forgot password" mode,
// `useServerConfig`, and the invitation-aware copy are all dropped rather
// than carried along unused. The sign in/sign up toggle and manual
// org-creation-on-signup flow are kept as-is.

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authErrorMessage, createOrganization, signIn, signUp } from "./client";

interface AuthScreenProps {
  /** Called once a session exists; the gate re-reads it from there. */
  onAuthenticated: () => void;
}

/** The app name beside the wordmark — the first thing a visitor sees. */
function Wordmark() {
  return <CardTitle className="text-xl">StepCut</CardTitle>;
}

export default function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [signingUp, setSigningUp] = useState(false);
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchMode(next: boolean) {
    setSigningUp(next);
    setError(null);
    setPassword("");
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (signingUp) {
        const { error: signUpError } = await signUp.email({
          email: email.trim(),
          password,
          name: name.trim(),
        });
        if (signUpError) throw new Error(authErrorMessage(signUpError));
        await createOrganization(orgName);
      } else {
        const { error: signInError } = await signIn.email({ email: email.trim(), password });
        if (signInError) throw new Error(authErrorMessage(signInError));
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    email.trim() !== "" &&
    password !== "" &&
    (!signingUp || (name.trim() !== "" && orgName.trim() !== ""));

  const description = signingUp
    ? "Create an account to turn a narrated screen recording into a step-by-step tutorial."
    : "Sign in to your account.";

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Wordmark />
          <CardDescription>{description}</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {signingUp && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="auth-name">Your name</Label>
                <Input
                  id="auth-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                />
              </div>
            )}

            {signingUp && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="auth-org">Organization</Label>
                <Input
                  id="auth-org"
                  value={orgName}
                  onChange={(event) => setOrgName(event.target.value)}
                  placeholder="Acme University"
                  autoComplete="organization"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Your recordings live here. You can invite colleagues later.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="auth-email">Email</Label>
              <Input
                id="auth-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="auth-password">Password</Label>
              <Input
                id="auth-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={signingUp ? "new-password" : "current-password"}
                required
              />
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={busy || !canSubmit}>
              {busy ? "Working…" : signingUp ? "Create account" : "Sign in"}
            </Button>
          </form>

          <p className="mt-4 text-sm text-muted-foreground">
            {signingUp ? "Already have an account?" : "No account yet?"}{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => switchMode(!signingUp)}
            >
              {signingUp ? "Sign in" : "Create one"}
            </Button>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
