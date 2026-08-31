// The render trigger + status panel — Phase 5 (docs/stepcut-plan.md §8:
// "Templates & render"), this slice. Split out of `StepsEditorView` rather
// than inlined there, purely to keep that already-sizable view from growing
// further; `StepsEditorView` owns whether a video has any steps and only
// mounts this panel once it does (the backend enforces the same rule anyway
// — `domain/renders.ts`'s `createRender` 400s on a stepless video — but
// hiding the action entirely is a better experience than letting a doomed
// request round-trip).
//
// Polling mirrors `DashboardView`'s shape exactly: the same
// `POLL_INTERVAL_MS`, a `setInterval` that re-fetches and is cleared on
// unmount/re-run, stopping once the thing being polled reaches a terminal
// state — here, `getRender` until `status` is `done`/`failed`/`cancelled`,
// there `listVideos`/`getSteps`+`getJobs` until upload/analysis settles.

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listTemplates, type Template } from "@/api/templates";
import {
  cancelRender,
  createRender,
  getRender,
  listRendersForVideo,
  type Render,
  type RenderFormat,
  type RenderSummary,
} from "@/api/renders";

interface RenderPanelProps {
  projectId: string;
  videoId: string;
}

const FORMAT_OPTIONS: Array<{ value: RenderFormat; label: string }> = [
  { value: "video", label: "Video (single file)" },
  { value: "markdown", label: "Markdown (per-step clips)" },
  { value: "html", label: "Web page (hosted link)" },
];

/** Same interval `DashboardView.tsx`'s `POLL_INTERVAL_MS` polls video/job
 * status at — reused rather than invented, per this phase's convention. */
const POLL_INTERVAL_MS = 1500;

function isTerminal(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function RenderPanel({ projectId, videoId }: RenderPanelProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templateId, setTemplateId] = useState<string>("");
  const [format, setFormat] = useState<RenderFormat>("video");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [active, setActive] = useState<Render | null>(null);
  const [history, setHistory] = useState<RenderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTemplates(projectId)
      .then((rows) => {
        if (cancelled) return;
        setTemplates(rows);
        setTemplateId((current) => current || (rows[0]?.id ?? ""));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await listRendersForVideo(videoId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [videoId]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  // Poll the active render until it settles — stop once it does, same
  // "don't quietly poll forever" discipline `DashboardView`'s own polling
  // effects follow.
  //
  // `stopped` guards against a request this effect fired but that resolves
  // *after* `active` has already moved on (a new render submitted, or a
  // cancel applied) — `clearInterval` on cleanup only stops future ticks, it
  // cannot un-send one already in flight. Without this guard, that stale
  // response's `setActive` can land after the newer state and silently
  // revert it — e.g. resurrecting a just-cancelled render's `queued` status,
  // or (if the stale response happened to be terminal) freezing polling on
  // an old render while a newly-submitted one never gets watched.
  useEffect(() => {
    if (!active || isTerminal(active.status)) return;
    let stopped = false;
    const targetId = active.id;
    const timer = setInterval(() => {
      getRender(targetId)
        .then((row) => {
          if (stopped) return;
          setActive(row);
          if (isTerminal(row.status)) void refreshHistory();
        })
        .catch((err) => {
          if (!stopped) setError(err instanceof Error ? err.message : String(err));
        });
    }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, refreshHistory]);

  const handleRender = async () => {
    if (!templateId) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createRender(videoId, templateId, format, callbackUrl.trim() || undefined);
      // `createRender` only returns `{ id, status }` — fetch the full row
      // once so the panel below has something to render immediately, same
      // as `DashboardView.handleFindSteps` loading its panel right after
      // queuing rather than waiting for the first poll tick.
      setActive(await getRender(created.id));
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!active) return;
    try {
      const updated = await cancelRender(active.id);
      setActive((current) => (current ? { ...current, ...updated } : current));
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** History rows never carry `output_url` (only `GET /renders/:id` mints
   * one), so a download from the list re-fetches the single render first —
   * consistent with "never a permanently public object, minted fresh on
   * every read" (plan §6) for `video`/`markdown`; for `html` the re-fetch is
   * just how the row learns its (permanent, not re-minted) page URL. */
  const handleDownload = async (id: string) => {
    setDownloadingId(id);
    setError(null);
    try {
      const row = await getRender(id);
      if (row.output_url) {
        window.open(row.output_url, "_blank", "noopener,noreferrer");
      } else {
        setError("This render's output isn't available to download.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="mt-6 rounded-lg border border-border p-4">
      <h2 className="mb-3 text-sm font-semibold">Render</h2>

      {error && (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {templatesLoading ? (
        <p className="text-sm text-muted-foreground">Loading templates…</p>
      ) : templates.length === 0 ? (
        // The template-fetch error itself is already shown above; this line
        // is only for the genuinely-empty case, so it doesn't misreport a
        // failed fetch as "you just haven't made one yet".
        !error && (
          <p className="text-sm text-muted-foreground">
            No templates yet — create one on the Templates screen before rendering.
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2">
          <Select value={templateId} onValueChange={setTemplateId} disabled={submitting}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={format} onValueChange={(value) => setFormat(value as RenderFormat)} disabled={submitting}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a format" />
            </SelectTrigger>
            <SelectContent>
              {FORMAT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            type="url"
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.target.value)}
            placeholder="Callback URL (optional)"
            disabled={submitting}
            aria-label="Callback URL (optional)"
          />

          <Button
            type="button"
            className="self-start"
            disabled={submitting || !templateId}
            onClick={() => void handleRender()}
          >
            {submitting ? "Starting…" : "Render"}
          </Button>
        </div>
      )}

      {active && (
        <div className="mt-4 rounded-md bg-muted/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium capitalize">{active.status}</span>
            {(active.status === "queued" || active.status === "running") && (
              <Button type="button" variant="outline" size="sm" onClick={() => void handleCancel()}>
                Cancel
              </Button>
            )}
          </div>

          {typeof active.progress === "number" && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.round(active.progress * 100)}%` }}
              />
            </div>
          )}

          {active.status === "failed" && active.error && (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>{active.error}</AlertDescription>
            </Alert>
          )}

          {active.status === "done" && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="mt-2 h-auto p-0 text-sm"
              disabled={downloadingId === active.id}
              onClick={() => void handleDownload(active.id)}
            >
              {downloadingId === active.id
                ? "Loading…"
                : active.format === "html"
                  ? "Open page"
                  : "Download"}
            </Button>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Past renders</h3>
          <ul className="flex flex-col gap-1.5">
            {history.map((render) => (
              <li key={render.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {formatDateTime(render.created_at)} — {render.status}
                </span>
                {render.status === "done" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={downloadingId === render.id}
                    onClick={() => void handleDownload(render.id)}
                  >
                    {downloadingId === render.id
                      ? "Loading…"
                      : render.format === "html"
                        ? "Open page"
                        : "Download"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
