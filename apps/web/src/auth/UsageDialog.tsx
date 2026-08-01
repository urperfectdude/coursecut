// Usage, limits, retention and the honest privacy statement (M7).
//
// **Why it is here and not in `SettingsView`.** `SettingsView` is a copied
// file, and §7.1 makes editing one for a web-only reason a bug — the desktop
// app has no tenant, no meter and no bill, so there is nothing there to add
// this to. It lives above the view tree with the rest of the web-only chrome,
// the same argument `AccountDialog` makes for account settings.
//
// **The privacy section is not decoration.** Plan §9 asks for the web app's
// weaker guarantee to be stated "in the product UI, not just a legal page",
// including the part that changed with D7: transcripts are processed under
// *our* OpenAI account, not the user's. This is that place. The retention
// numbers beside it come from the server rather than from a constant here, so
// the page cannot claim a window the sweep is not actually running.
//
// Built from the primitives already copied into `components/ui` (§4.1's rule).
// `Progress` is one of them, which is what a quota meter wants anyway.

import { useCallback, useEffect, useState } from "react";
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
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { request } from "../api";
import { authErrorMessage, organization } from "./client";

interface UsageResponse {
  period_start: string;
  transcription: { minutes_used: number; minutes_limit: number };
  storage: { bytes_used: number; bytes_limit: number; max_upload_bytes: number };
  jobs: { active: number; limit: number };
  retention: { source_days: number; export_days: number };
  suspended: { since: string; reason: string | null } | null;
}

interface UsageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  orgName: string;
  /** The caller's role in the active org. Only an owner sees the danger zone. */
  role: string | null;
  /** Called after the org is deleted, so the shell can re-read which orgs are
   * left and switch to one of them. */
  onOrgDeleted: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`;
}

/** A percentage clamped for display: 100 is full, and 140% of a quota (which
 * the deliberate overshoot in `quota.ts` allows) should render as a full bar
 * rather than as a broken one. */
function percent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.round((used / limit) * 100));
}

export default function UsageDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
  role,
  onOrgDeleted,
}: UsageDialogProps) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsage(await request<UsageResponse>("GET", "/usage"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function handleDeleteOrg() {
    setDeleting(true);
    setError(null);
    // Through `better-auth`, like every other org write (see `AppShell`): the
    // API's own delete hook is what purges the objects, and it hangs off the
    // library's endpoint rather than a second one of ours.
    const { error: deleteError } = await organization.delete({ organizationId: orgId });
    setDeleting(false);
    if (deleteError) {
      setError(authErrorMessage(deleteError));
      return;
    }
    onOrgDeleted();
    onOpenChange(false);
  }

  const periodLabel = usage
    ? new Date(usage.period_start).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Usage &amp; limits</DialogTitle>
          <DialogDescription>{orgName}</DialogDescription>
        </DialogHeader>

        {usage?.suspended && (
          <Alert variant="destructive">
            <AlertDescription>
              This organization is suspended
              {usage.suspended.reason ? `: ${usage.suspended.reason}` : "."} Uploads, transcription
              and exports are paused. Your existing files are untouched.
            </AlertDescription>
          </Alert>
        )}

        {usage && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <Label>Transcription — {periodLabel}</Label>
                <span className="text-sm text-muted-foreground">
                  {formatMinutes(usage.transcription.minutes_used)} of{" "}
                  {formatMinutes(usage.transcription.minutes_limit)}
                </span>
              </div>
              <Progress
                value={percent(
                  usage.transcription.minutes_used,
                  usage.transcription.minutes_limit,
                )}
              />
              <p className="text-xs text-muted-foreground">
                Resets on the first of each month.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <Label>Storage</Label>
                <span className="text-sm text-muted-foreground">
                  {formatBytes(usage.storage.bytes_used)} of {formatBytes(usage.storage.bytes_limit)}
                </span>
              </div>
              <Progress value={percent(usage.storage.bytes_used, usage.storage.bytes_limit)} />
              <p className="text-xs text-muted-foreground">
                Source videos and finished exports. Up to{" "}
                {formatBytes(usage.storage.max_upload_bytes)} per file. Deleting a project frees its
                space immediately.
              </p>
            </div>

            <div className="flex items-baseline justify-between">
              <Label>Jobs running now</Label>
              <span className="text-sm text-muted-foreground">
                {usage.jobs.active} of {usage.jobs.limit}
              </span>
            </div>

            <Separator />

            {/* Plan §9, in the product rather than in a policy page. */}
            <div className="flex flex-col gap-2">
              <Label>Your video and your data</Label>
              <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
                <li>
                  Uploaded video is stored on infrastructure we operate, encrypted at rest, and kept
                  separate from every other organization&apos;s.
                </li>
                <li>
                  Video is never sent to a third party. Only the extracted audio goes to the
                  transcription model, and only the transcript text goes to the analysis model —
                  under <strong>our</strong> OpenAI account, not yours, so their data-handling terms
                  for our account are the ones that apply.
                </li>
                <li>
                  Deleting a project or a video purges its files from storage.
                  {usage.retention.source_days > 0
                    ? ` Uploads are also removed automatically after ${usage.retention.source_days} days.`
                    : " Uploads are kept until you delete them."}
                </li>
                <li>
                  Exported files stay downloadable for {usage.retention.export_days} days, then are
                  removed. The lesson stays — you can export it again.
                </li>
              </ul>
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {role === "owner" && (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <Label htmlFor="usage-confirm-org">Delete this organization</Label>
              <p className="text-xs text-muted-foreground">
                Removes every project, video, transcript, lesson and export in {orgName}, and purges
                the files from storage. This cannot be undone. Type the organization&apos;s name to
                confirm.
              </p>
              <div className="flex gap-2">
                <Input
                  id="usage-confirm-org"
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                  placeholder={orgName}
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deleting || confirmName.trim() !== orgName}
                  onClick={() => void handleDeleteOrg()}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
