// What this org has used, and what it is allowed (M7).
//
// A web-only surface, like `orgs.ts`, and for the same reason: the desktop app
// has no tenant, no meter and no bill, so there is nothing to port and nothing
// in `db.ts` that should learn about this. It is consumed by
// `apps/web/src/auth/UsageDialog.tsx`, which sits above the copied view tree —
// plan §4.1's rule that no copied view sees a web-only concept applies to
// quotas exactly as it applies to sessions.
//
// The other half of what it returns is the honest privacy statement plan §9
// asks to be "in the product UI, not just a legal page": the retention that is
// actually in force for this org, computed from the same values the sweep
// reads, so the page cannot drift from the behaviour.

import { Hono } from "hono";
import { tx, type AppEnv } from "../http/context.js";
import { env } from "../env.js";
import { limitsFor, usageFor } from "../quota.js";

export const usageRoutes = new Hono<AppEnv>();

usageRoutes.get("/usage", async (c) => {
  const orgId = c.get("orgId");
  const { limits, usage } = await tx(c, async (t) => ({
    limits: await limitsFor(t, orgId),
    usage: await usageFor(t, orgId),
  }));

  return c.json({
    period_start: usage.periodStart,
    transcription: {
      minutes_used: Math.round(usage.transcriptionMinutes * 10) / 10,
      minutes_limit: limits.transcriptionMinutesPerMonth,
    },
    storage: {
      bytes_used: usage.storageBytes,
      bytes_limit: limits.storageBytes,
      max_upload_bytes: limits.maxUploadBytes,
    },
    jobs: {
      active: usage.activeJobs,
      limit: limits.maxActiveJobs,
    },
    retention: {
      // 0 means source video is kept until someone deletes it. The dialog says
      // so in words rather than printing "0 days", which would read as
      // "deleted immediately".
      source_days: limits.retentionDays,
      export_days: env.retentionExportDays(),
    },
    suspended: limits.suspendedAt
      ? { since: limits.suspendedAt.toISOString(), reason: limits.suspendedReason }
      : null,
  });
});
