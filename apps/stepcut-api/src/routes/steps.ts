// Step editing routes — Phase 4 (docs/stepcut-plan.md §8: "Manual editing").
//
// Thin shells around `domain/steps.ts`, same split `apps/api/src/routes/
// lessons.ts` uses and for the same reason: the editing rules have to stay
// reviewable against that file's port of desktop's semantics, while the HTTP
// shapes are this file's business.
//
// Mounted under `/api` directly, not `/v1` — same call `routes/videos.ts`'s
// header already makes: `/v1/...` is the plan's sketch of the *eventual
// public API surface* (plan §4), and nothing about the API-key auth that
// surface needs (plan §8 Phase 6) exists yet. These routes stay consistent
// with what's actually deployed.

import { Hono } from "hono";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { param, tx, type AppEnv } from "../http/context.js";
import { badRequest } from "../http/errors.js";
import * as serialize from "../http/serialize.js";
import * as domain from "../domain/steps.js";
import { steps, transcriptSegments } from "../db/schema.js";
import { editSteps, extractTimestampsSeconds } from "../openai.js";

export const stepRoutes = new Hono<AppEnv>();

/** Padding either side of the video's step span for the transcript context
 * sent with an edit prompt — same value and rationale as apps/api's
 * `LESSON_EDIT_CONTEXT_PAD_SECS`: enough for the model to see around the
 * current steps ("cut the tangent right before the demo starts") without
 * shipping a whole recording's transcript for a scoped edit. Also the pad
 * folded in around any timestamp the instruction names. */
const STEP_EDIT_CONTEXT_PAD_SECS = 60;

function numberField(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}

stepRoutes.patch("/steps/:id", async (c) => {
  const id = param(c, "id");
  const body = await c.req.json<{
    start?: number;
    end?: number;
    title?: string | null;
    summary?: string | null;
  }>();

  const patch: domain.StepPatch = {};
  if (body.start !== undefined) patch.start = numberField(body.start, "start");
  if (body.end !== undefined) patch.end = numberField(body.end, "end");
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.summary === "string") patch.summary = body.summary;

  const row = await tx(c, (t) => domain.updateStep(t, id, patch));
  return c.json(serialize.step(row));
});

stepRoutes.post("/steps/:id/split", async (c) => {
  const id = param(c, "id");
  const body = await c.req.json<{ at?: number }>();
  const at = numberField(body.at, "at");

  const rows = await tx(c, (t) => domain.splitStep(t, c.get("orgId"), id, at));
  return c.json(rows.map(serialize.step));
});

stepRoutes.delete("/steps/:id", async (c) => {
  const id = param(c, "id");
  await tx(c, (t) => domain.deleteStep(t, id));
  return c.body(null, 204);
});

stepRoutes.post("/videos/:id/steps", async (c) => {
  const videoId = param(c, "id");
  const body = await c.req.json<{ start?: number; end?: number; title?: string; summary?: string }>();

  const row = await tx(c, (t) =>
    domain.addStep(t, c.get("orgId"), videoId, {
      start: numberField(body.start, "start"),
      end: numberField(body.end, "end"),
      title: body.title ?? "",
      summary: body.summary,
    }),
  );
  return c.json(serialize.step(row));
});

// --- Free-text AI step-list edit -------------------------------------------
//
// The floating prompt box on `StepsEditorView`. Proposing is a pure read
// that calls GPT-5.5 and writes nothing; applying is a pure write that never
// calls the model — the review step in between is what makes a proposal
// something the user accepts rather than something that lands unreviewed.
// Same split as apps/api's `/lessons/:id/segment-edit/preview|apply`.

function stepEditBody(entry: unknown): { start: number; end: number; title: string; summary: string } {
  const raw = entry as { start?: unknown; end?: unknown; title?: unknown; summary?: unknown };
  const start = Number(raw.start);
  const end = Number(raw.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw badRequest("each step needs a numeric start and end");
  }
  return {
    start,
    end,
    title: typeof raw.title === "string" ? raw.title : "",
    summary: typeof raw.summary === "string" ? raw.summary : "",
  };
}

function stepEditBaseline(value: unknown): ReturnType<typeof stepEditBody>[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw badRequest("baseline must be an array of steps");
  return value.map(stepEditBody);
}

/**
 * Proposes a revised step list for `videoId`. Writes nothing.
 *
 * `baseline` is absent for the prompt box's first submission (the video's
 * current steps are the baseline) and present for a refinement typed inside
 * the review popup — in which case it is the *previous, not-yet-applied*
 * proposal, since nothing has been written yet. The transcript context
 * window is always sized from the video's **own real** steps, never the
 * resolved baseline, so a refinement's window does not drift just because
 * the hypothetical proposal has moved away from the video's actual
 * footprint — then widened around any timestamp the instruction names.
 *
 * Only transcript text and the steps' own start/end/title/summary reach
 * OpenAI — never audio, never video.
 */
stepRoutes.post("/videos/:id/steps/edit/preview", async (c) => {
  const videoId = param(c, "id");
  const body = await c.req.json<{ instruction?: string; baseline?: unknown }>();
  const instruction = (body.instruction ?? "").trim();
  if (instruction.length === 0) {
    throw badRequest("Describe the change you want before previewing it.");
  }
  const baseline = stepEditBaseline(body.baseline);

  const context = await tx(c, async (t) => {
    const own = await t
      .select()
      .from(steps)
      .where(eq(steps.videoId, videoId))
      .orderBy(asc(steps.sortOrder), asc(steps.start));

    // `windowEnd === null` means "no steps yet, so no upper bound from
    // them" — widened below only if the instruction names a timestamp.
    let windowStart = own.length > 0 ? Math.min(...own.map((step) => step.start)) : 0;
    let windowEnd: number | null = own.length > 0 ? Math.max(...own.map((step) => step.end)) : null;
    windowStart -= STEP_EDIT_CONTEXT_PAD_SECS;
    if (windowEnd !== null) windowEnd += STEP_EDIT_CONTEXT_PAD_SECS;

    for (const timestamp of extractTimestampsSeconds(instruction)) {
      windowStart = Math.min(windowStart, timestamp - STEP_EDIT_CONTEXT_PAD_SECS);
      const widened = timestamp + STEP_EDIT_CONTEXT_PAD_SECS;
      windowEnd = windowEnd === null ? widened : Math.max(windowEnd, widened);
    }

    const transcript = await t
      .select({
        start: transcriptSegments.start,
        end: transcriptSegments.end,
        text: transcriptSegments.text,
      })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.videoId, videoId),
          gte(transcriptSegments.end, windowStart),
          windowEnd === null ? undefined : lte(transcriptSegments.start, windowEnd),
        ),
      )
      .orderBy(asc(transcriptSegments.start), asc(transcriptSegments.id));

    return {
      baseline:
        baseline ??
        own.map((step) => ({
          start: step.start,
          end: step.end,
          title: step.title,
          summary: step.summary ?? "",
        })),
      transcript,
    };
  });

  // Outside the transaction on purpose: a model call can take up to three
  // minutes (`COMPLETION_TIMEOUT_MS`), and holding a pinned transaction open
  // for it would tie up a pooled connection for the duration.
  const proposed = await editSteps(context.baseline, context.transcript, instruction);
  return c.json(proposed);
});

stepRoutes.post("/videos/:id/steps/edit/apply", async (c) => {
  const videoId = param(c, "id");
  const body = await c.req.json<{ steps?: unknown }>();
  if (!Array.isArray(body.steps)) throw badRequest("steps must be an array");
  const edits = body.steps.map(stepEditBody);

  const rows = await tx(c, (t) => domain.replaceSteps(t, c.get("orgId"), videoId, edits));
  return c.json(rows.map(serialize.step));
});
