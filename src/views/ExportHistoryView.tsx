import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelExport,
  listExports,
  pauseExport,
  queueExport,
  resumeExport,
  retryExport,
  revealInFolder,
  type ExportRow,
} from "../db";
import { ACTIVE_EXPORT_STATUSES } from "./LessonEditorView";
import { basename, dirname, formatDuration } from "./ProjectDetailView";

/** How often this view polls `listExports` while at least one export in
 * this project is still active (queued/paused/running) — same interval and
 * "poll only while something's active" approach as `LessonEditorView`'s own
 * export queue panel (see `EXPORT_POLL_INTERVAL_MS` there), duplicated here
 * rather than exported since it's a trivial constant and importing it would
 * only save one line. */
const EXPORT_POLL_INTERVAL_MS = 1500;

interface ExportHistoryViewProps {
  projectId: string;
  onBack: () => void;
}

/** Project-level Export History (PRD §11, Milestone 8): every export ever
 * queued for this project, not just the ones still active in a single
 * video's editor — `listExports` already returns full history (Milestone 7),
 * this view is the first place that surfaces all of it rather than the
 * per-video slice `LessonEditorView`'s queue panel filters down to. */
export default function ExportHistoryView({ projectId, onBack }: ExportHistoryViewProps) {
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-row in-flight guard, same pattern as `LessonEditorView`'s
  // `exportBusyRef`/`exportBusyIds` — covers every row action below
  // (Pause/Resume/Cancel/Retry/Re-export/Show in folder), keyed by export
  // id, so a rapid double-click can't fire two concurrent actions against
  // the same row.
  const actionBusyRef = useRef<Set<string>>(new Set());
  const [actionBusyIds, setActionBusyIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      setExports(await listExports(projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listExports(projectId)
      .then((rows) => {
        if (!cancelled) setExports(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Poll while any export in this project is still active, same rationale
  // as `LessonEditorView`'s own polling effect: reflect progress/status
  // updates for an export that's running elsewhere while the user is
  // looking at history, without polling forever once everything's settled.
  useEffect(() => {
    const hasActive = exports.some((row) => ACTIVE_EXPORT_STATUSES.has(row.status));
    if (!hasActive) return;
    const interval = setInterval(() => {
      void refresh();
    }, EXPORT_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [exports, refresh]);

  const handleReExport = useCallback(
    async (row: ExportRow) => {
      if (actionBusyRef.current.has(row.id)) return;
      actionBusyRef.current.add(row.id);
      setActionBusyIds(new Set(actionBusyRef.current));
      try {
        const outputDir = dirname(row.output_path);
        // A new export row, preserving this one as history rather than
        // mutating it (PRD §11: "store every export" / "allow users to
        // re-export").
        await queueExport([row.lesson_id], outputDir);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        actionBusyRef.current.delete(row.id);
        setActionBusyIds(new Set(actionBusyRef.current));
      }
    },
    [refresh],
  );

  /** Pause/Resume/Cancel/Retry all share this shape — same convention as
   * `LessonEditorView`'s own `handleExportAction`, which this page's inline
   * queue panel used to be (see the conversation that moved it here). */
  const handleAction = useCallback(
    async (id: string, action: (id: string) => Promise<ExportRow>) => {
      if (actionBusyRef.current.has(id)) return;
      actionBusyRef.current.add(id);
      setActionBusyIds(new Set(actionBusyRef.current));
      try {
        await action(id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        actionBusyRef.current.delete(id);
        setActionBusyIds(new Set(actionBusyRef.current));
      }
    },
    [refresh],
  );

  const handleRevealInFolder = useCallback(async (row: ExportRow) => {
    try {
      await revealInFolder(row.output_path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div>
      <button type="button" className="back-button" onClick={onBack}>
        ← Back to project
      </button>

      <h1>Export History</h1>

      {loading && <p>Loading export history…</p>}
      {error && <p className="error">{error}</p>}

      {!loading && exports.length === 0 && <p>No exports yet for this project.</p>}

      {exports.length > 0 && (
        <ul className="export-history-list">
          {exports.map((row) => {
            const isBusy = actionBusyIds.has(row.id);
            const isActive = ACTIVE_EXPORT_STATUSES.has(row.status);
            const duration = row.lesson_end - row.lesson_start;
            return (
              <li key={row.id} className="export-item export-history-item">
                <div className="export-item-header">
                  <span className="export-item-title">{row.lesson_title}</span>
                  <span className={`status-badge export-status-badge status-${row.status}`}>
                    {row.status}
                  </span>
                </div>
                <div className="export-history-meta">
                  <span>{new Date(row.created_at).toLocaleString()}</span>
                  <span>{basename(row.video_file_path)}</span>
                  <span>{formatDuration(duration)}</span>
                  <span className="export-history-path">{dirname(row.output_path)}</span>
                </div>
                {isActive && (
                  <div className="export-progress">
                    <progress value={row.progress} max={1} />
                    <span className="export-progress-label">{Math.round(row.progress * 100)}%</span>
                  </div>
                )}
                {row.status === "failed" && row.error && (
                  <p className="error export-error">{row.error}</p>
                )}
                <div className="export-item-actions">
                  {row.status === "queued" && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleAction(row.id, pauseExport)}
                    >
                      Pause
                    </button>
                  )}
                  {row.status === "paused" && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleAction(row.id, resumeExport)}
                    >
                      Resume
                    </button>
                  )}
                  {(row.status === "queued" || row.status === "paused" || row.status === "running") && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleAction(row.id, cancelExport)}
                    >
                      Cancel
                    </button>
                  )}
                  {(row.status === "failed" || row.status === "cancelled") && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleAction(row.id, retryExport)}
                    >
                      Retry
                    </button>
                  )}
                  {row.status === "done" && (
                    <button type="button" onClick={() => void handleRevealInFolder(row)}>
                      Show in folder
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={isBusy || isActive}
                    onClick={() => void handleReExport(row)}
                  >
                    {isActive ? "Export in progress…" : "Re-export"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
