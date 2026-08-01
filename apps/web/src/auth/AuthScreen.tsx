// Sign in / sign up (plan §4.1, D8) — a surface the desktop app has no
// counterpart for, since desktop is a single local user with no accounts.
//
// Built strictly from the primitives already copied into `components/ui`, per
// §4.1's governing rule: no new design language, no second component library.
// It should read like a screen that shipped with the desktop app.
//
// **Password reset is conditional, not absent (M7).** It was absent through M4
// because it needs an email provider and the plan left that undecided (§10) —
// a link to a form whose mail never arrives is the thing D7 refuses to ship.
// M7 made the provider a deployment variable rather than a code decision
// (`apps/api/src/mail.ts`), so the link now appears exactly when the server
// says mail works, and the flow it opens is real wherever it is offered.

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  authErrorMessage,
  createOrganization,
  requestPasswordReset,
  resetPassword,
  signIn,
  signUp,
} from "./client";
import {
  clearResetParams,
  readResetError,
  readResetToken,
  resetRedirectTo,
} from "./passwordReset";
import { useServerConfig } from "./useServerConfig";

type Mode = "signin" | "signup" | "forgot" | "reset";

interface AuthScreenProps {
  /** True when the visitor arrived on an invitation link. They are joining an
   * existing org, so sign-up must not also create one for them. */
  hasPendingInvitation: boolean;
  /** Called once a session exists; the gate re-reads it from there. */
  onAuthenticated: () => void;
}

export default function AuthScreen({ hasPendingInvitation, onAuthenticated }: AuthScreenProps) {
  // A reset token in the URL means the visitor followed a link from their
  // mail, so that screen wins over whichever one they would otherwise land on.
  const [resetToken] = useState(readResetToken);
  const [mode, setMode] = useState<Mode>(
    resetToken ? "reset" : hasPendingInvitation ? "signup" : "signin",
  );
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(() =>
    // `better-auth` redirects here with `?error=INVALID_TOKEN` when a link has
    // expired or already been used. Both look identical to the person holding
    // it, so it has to be said rather than left as an empty form.
    readResetError() ? "That reset link is no longer valid. Ask for a new one." : null,
  );

  const config = useServerConfig();
  const signingUp = mode === "signup";

  // Read once into state above, then stripped: a reload must not replay a
  // token that has already been spent.
  useEffect(() => clearResetParams(), []);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setStatus(null);
    setPassword("");
  }

  async function handleForgot(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: resetError } = await requestPasswordReset({
      email: email.trim(),
      redirectTo: resetRedirectTo(),
    });
    setBusy(false);
    if (resetError) {
      setError(authErrorMessage(resetError));
      return;
    }
    // Deliberately the same message whether or not the address is registered —
    // the server answers that way too, and telling a stranger which addresses
    // have accounts is a disclosure, not a courtesy.
    setStatus("If that address has an account, a reset link is on its way.");
  }

  async function handleReset(event: React.FormEvent) {
    event.preventDefault();
    if (!resetToken) return;
    setBusy(true);
    setError(null);
    const { error: resetError } = await resetPassword({ newPassword: password, token: resetToken });
    setBusy(false);
    if (resetError) {
      setError(authErrorMessage(resetError));
      return;
    }
    setPassword("");
    setMode("signin");
    setStatus("Password updated. Sign in with your new password.");
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
        // An invited user joins their inviter's org instead — the gate accepts
        // the invitation as soon as this session exists.
        if (!hasPendingInvitation) await createOrganization(orgName);
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
    (!signingUp || (name.trim() !== "" && (hasPendingInvitation || orgName.trim() !== "")));

  const description = hasPendingInvitation
    ? "You've been invited to an organization. Sign up — or sign in — with the email address it was sent to."
    : mode === "signup"
      ? "Create an account to turn lecture recordings into lessons."
      : mode === "forgot"
        ? "Enter your email address and we'll send you a link to set a new password."
        : mode === "reset"
          ? "Choose a new password for your account."
          : "Sign in to your account.";

  if (mode === "forgot" || mode === "reset") {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">CourseCut</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>

          <CardContent>
            <form
              onSubmit={mode === "forgot" ? handleForgot : handleReset}
              className="flex flex-col gap-4"
            >
              {mode === "forgot" ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="auth-reset-email">Email</Label>
                  <Input
                    id="auth-reset-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="auth-new-password">New password</Label>
                  <Input
                    id="auth-new-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
              )}

              {status && (
                <Alert>
                  <AlertDescription>{status}</AlertDescription>
                </Alert>
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                disabled={busy || (mode === "forgot" ? email.trim() === "" : password === "")}
              >
                {busy ? "Working…" : mode === "forgot" ? "Send reset link" : "Set new password"}
              </Button>
            </form>

            <p className="mt-4 text-sm text-muted-foreground">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => switchMode("signin")}
              >
                Back to sign in
              </Button>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">CourseCut</CardTitle>
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

            {signingUp && !hasPendingInvitation && (
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
                  Your projects live here. You can invite colleagues later.
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

            {status && (
              <Alert>
                <AlertDescription>{status}</AlertDescription>
              </Alert>
            )}
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
              onClick={() => switchMode(signingUp ? "signin" : "signup")}
            >
              {signingUp ? "Sign in" : "Create one"}
            </Button>
          </p>

          {/* Only when the server says mail is configured — see this file's
              header, and `useServerConfig`. */}
          {!signingUp && config.password_reset && (
            <p className="mt-1 text-sm text-muted-foreground">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => switchMode("forgot")}
              >
                Forgot your password?
              </Button>
            </p>
          )}

          {/* Plan §9 asks for the web app's guarantee to be stated in the
              product. The full version is in Usage &amp; limits, once there is
              an org to state it about; this is the line that has to be visible
              *before* someone uploads anything. */}
          {signingUp && (
            <p className="mt-4 text-xs text-muted-foreground">
              Your video is stored on infrastructure we operate and is never sent to a third party.
              Only the extracted audio and the transcript text are sent to OpenAI, under our
              account, to transcribe and find lesson boundaries.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
