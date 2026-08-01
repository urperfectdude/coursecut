// Account settings (plan §4.1) — "sits alongside the existing SettingsView,
// not replacing it".
//
// Alongside, and deliberately not inside: `SettingsView` is a copied file, and
// §7.1 makes editing one for a web-only reason a bug. Analysis instructions
// stay where desktop puts them; who you are signed in as is web-only and lives
// here, above the view tree, where no copied view can see it.
//
// A `Dialog` rather than a screen because `components/ui` has no dropdown menu
// and §4.1 forbids adding one — the primitives already copied are the whole
// vocabulary.
//
// Email is shown but not editable: changing it needs a verification mail, and
// mail is optional in this product (`MAIL_DRIVER` unset is a supported
// deployment — see `apps/api/src/mail.ts`), so an address change would work on
// some deployments and silently not on others. Password *reset* is the one
// that became conditional instead of absent at M7, because it is opt-in per
// attempt rather than in the path of every account edit.
//
// Account deletion is here (M7). It is the user-facing half of plan §9's
// deletion promise: signing out stops using the product, deleting removes what
// it holds. The server refuses it for someone who is the last owner of an org
// with other members in it, and purges the orgs they were alone in.

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { authErrorMessage, changePassword, deleteUser, signOut, updateUser } from "./client";

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { name: string; email: string };
  /** Re-reads the session so a renamed user shows up in the shell's bar. */
  onUpdated: () => void;
}

export default function AccountDialog({
  open,
  onOpenChange,
  user,
  onUpdated,
}: AccountDialogProps) {
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [busy, setBusy] = useState<"name" | "password" | "delete" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSaveName(event: React.FormEvent) {
    event.preventDefault();
    setBusy("name");
    setStatus(null);
    setError(null);
    const { error: updateError } = await updateUser({ name: name.trim() });
    setBusy(null);
    if (updateError) {
      setError(authErrorMessage(updateError));
      return;
    }
    setStatus("Name updated.");
    onUpdated();
  }

  async function handleChangePassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy("password");
    setStatus(null);
    setError(null);
    const { error: changeError } = await changePassword({
      currentPassword,
      newPassword,
      // Changing a password is also how someone reacts to thinking it leaked,
      // so every other session goes with it.
      revokeOtherSessions: true,
    });
    setBusy(null);
    if (changeError) {
      setError(authErrorMessage(changeError));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setStatus("Password changed. Other sessions have been signed out.");
  }

  /**
   * Deletes the account.
   *
   * The current password is required by `better-auth` on this endpoint, and it
   * is the right check: possession of an unlocked browser is not consent to
   * destroy someone's work. There is no confirmation dialog on top of it — the
   * password field *is* the confirmation, and stacking a second one on a
   * primitive `components/ui` does not have (§4.1) would add ceremony, not
   * safety.
   */
  async function handleDeleteAccount(event: React.FormEvent) {
    event.preventDefault();
    setBusy("delete");
    setStatus(null);
    setError(null);
    const { error: deleteError } = await deleteUser({ password: deletePassword });
    setBusy(null);
    if (deleteError) {
      setError(authErrorMessage(deleteError));
      return;
    }
    // The session is gone with the account, so there is nothing to re-read:
    // reloading drops the SPA back on the sign-in screen with clean state.
    window.location.reload();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSaveName} className="flex flex-col gap-2">
          <Label htmlFor="account-name">Name</Label>
          <div className="flex gap-2">
            <Input
              id="account-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
            />
            <Button type="submit" disabled={busy !== null || !name.trim() || name === user.name}>
              {busy === "name" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>

        <Separator />

        <form onSubmit={handleChangePassword} className="flex flex-col gap-2">
          <Label htmlFor="account-current-password">Current password</Label>
          <Input
            id="account-current-password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
          />
          <Label htmlFor="account-new-password" className="mt-2">
            New password
          </Label>
          <Input
            id="account-new-password"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
          />
          <Button
            type="submit"
            variant="outline"
            className="mt-2 self-start"
            disabled={busy !== null || !currentPassword || !newPassword}
          >
            {busy === "password" ? "Changing…" : "Change password"}
          </Button>
        </form>

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

        <Separator />

        {/* `justify-self-`, not `self-`: `DialogContent` lays its children out
            in a grid, where `align-self` is the block axis. */}
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={() => void signOut()}
        >
          Sign out
        </Button>

        <Separator />

        <form onSubmit={handleDeleteAccount} className="flex flex-col gap-2">
          <Label htmlFor="account-delete-password">Delete this account</Label>
          <p className="text-xs text-muted-foreground">
            Removes your account permanently. Any organization where you are the only member is
            deleted with it, including its videos and exports. Organizations you share with other
            people are left alone — hand ownership over first if you want one to survive.
          </p>
          <Input
            id="account-delete-password"
            type="password"
            value={deletePassword}
            onChange={(event) => setDeletePassword(event.target.value)}
            placeholder="Current password"
            autoComplete="current-password"
          />
          <Button
            type="submit"
            variant="destructive"
            className="mt-1 justify-self-start"
            disabled={busy !== null || !deletePassword}
          >
            {busy === "delete" ? "Deleting…" : "Delete account"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
