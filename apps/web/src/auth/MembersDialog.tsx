// Members and invitations (plan §4.1) — web-only, no desktop counterpart.
//
// **Invitations are links, not emails.** `better-auth` creates the invitation
// row whether or not `sendInvitationEmail` is configured, and it is not
// configured, because the transactional email provider is still an open
// question (plan §10). So the invite flow ends with a link the inviter sends
// however they like. That is a real, working invitation — not a placeholder —
// and when the provider lands, this screen keeps working while the mail
// becomes the primary path.
//
// The invitee must sign up with the address the invitation names:
// `acceptInvitation` compares it against the session's email and refuses a
// mismatch. The dialog says so rather than letting them find out.

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { authErrorMessage, organization } from "./client";
import { invitationLink } from "./invitation";

interface MemberRow {
  id: string;
  role: string;
  user: { id: string; name?: string | null; email: string };
}

interface InvitationRow {
  id: string;
  email: string;
  role?: string | null;
  status: string;
}

interface MembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgName: string;
  /** The caller's role in this org — only owners and admins may invite or
   * remove. The server enforces it too; this only avoids offering a button
   * that would be refused. */
  role: string | null;
  currentUserId: string;
}

export default function MembersDialog({
  open,
  onOpenChange,
  orgName,
  role,
  currentUserId,
}: MembersDialogProps) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = role === "owner" || role === "admin";

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error: loadError } = await organization.getFullOrganization();
    if (loadError) {
      setError(authErrorMessage(loadError));
    } else if (data) {
      setMembers((data.members ?? []) as MemberRow[]);
      setInvitations(
        ((data.invitations ?? []) as InvitationRow[]).filter(
          (invitation) => invitation.status === "pending",
        ),
      );
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function handleInvite(event: React.FormEvent) {
    event.preventDefault();
    setInviting(true);
    setError(null);
    setCopied(false);
    const { data, error: inviteError } = await organization.inviteMember({
      email: email.trim(),
      role: "member",
    });
    setInviting(false);
    if (inviteError || !data) {
      setError(authErrorMessage(inviteError));
      return;
    }
    setLastLink(invitationLink(data.id));
    setEmail("");
    await refresh();
  }

  async function handleCancel(invitationId: string) {
    const { error: cancelError } = await organization.cancelInvitation({ invitationId });
    if (cancelError) setError(authErrorMessage(cancelError));
    await refresh();
  }

  async function handleRemove(memberId: string) {
    const { error: removeError } = await organization.removeMember({ memberIdOrEmail: memberId });
    if (removeError) setError(authErrorMessage(removeError));
    await refresh();
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard access is denied outside a secure context; the link is on
      // screen and selectable either way, so this is not worth an error.
      setCopied(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Members</DialogTitle>
          <DialogDescription>{orgName}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-3">
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{member.user.name || member.user.email}</span>
                  <span className="text-xs text-muted-foreground">{member.user.email}</span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">{member.role}</Badge>
                  {canManage && member.user.id !== currentUserId && member.role !== "owner" && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleRemove(member.id)}
                    >
                      Remove
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {invitations.length > 0 && (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Pending invitations</p>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {invitations.map((invitation) => (
                  <li key={invitation.id} className="flex items-center justify-between gap-3">
                    <span className="text-sm">{invitation.email}</span>
                    <span className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void copyLink(invitationLink(invitation.id))}
                      >
                        Copy link
                      </Button>
                      {canManage && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => void handleCancel(invitation.id)}
                        >
                          Cancel
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {canManage && (
          <>
            <Separator />
            <form onSubmit={handleInvite} className="flex flex-col gap-2">
              <Label htmlFor="invite-email">Invite by email</Label>
              <div className="flex gap-2">
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="colleague@example.com"
                />
                <Button type="submit" disabled={inviting || !email.trim()}>
                  {inviting ? "Inviting…" : "Invite"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Email delivery isn't set up yet, so send the invitation link yourself. They must sign
                up with the address you invited.
              </p>
            </form>
          </>
        )}

        {lastLink && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-link">Invitation link</Label>
            <div className="flex gap-2">
              <Input id="invite-link" readOnly value={lastLink} onFocus={(e) => e.target.select()} />
              <Button type="button" variant="outline" onClick={() => void copyLink(lastLink)}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </DialogContent>
    </Dialog>
  );
}
