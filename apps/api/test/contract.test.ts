/// <reference types="vite/client" />
//
// M3's acceptance criterion, literally: "`apps/web`'s `db.ts` passes contract
// tests against the real API" (plan §7).
//
// So this suite imports **the shipped client** — `apps/web/src/db.ts`, the
// same file the SPA bundles — and drives it against the real Hono app, a real
// Postgres and a real MinIO. Nothing about the request or response shapes is
// re-typed here, which is the whole point: a re-typed copy would keep passing
// after the two sides drifted apart, and drift is the exact failure mode this
// plan is built to catch (§7.1).
//
// The import crosses a package boundary, and that is worth a word. `apps/api`
// and `apps/web` install separately and neither depends on the other at
// runtime; this is a test reaching for the artifact under test, in the one
// direction where it means something. Nothing under `src/` (the desktop app)
// is touched — plan §0's rule is about the desktop tree, and it holds.
//
// What is deliberately *not* covered:
//
//   * `previewLessonSegmentEdit` beyond its refusal — it needs a live model,
//     which arrives with the worker (M5). The refusal itself is asserted, so
//     the gap is pinned rather than assumed.
//   * `pickExportDirectory`, which is a constant.
//
// Run it the way a developer does:
//
//   docker compose -f infra/postgres/compose.yml up -d --wait
//   cd apps/api && npm run db:reset && npm test

import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closePool } from "../src/db/client.js";
import { closeProgressListener } from "../src/events.js";
import { SEED, SEED_PASSWORD, seed } from "../src/db/seed.js";
import { clearCookies, installBrowserGlobals, lastOpenedUrl, signIn } from "./browser.js";
import * as db from "../../web/src/db.js";
import { ApiError } from "../../web/src/api/http.js";

const PART_SIZE = 64 * 1024 * 1024;

let server: ReturnType<typeof serve>;
let origin: string;

/** A `File` of `size` bytes. The contents do not matter — what is under test
 * is that every byte arrives, which the round-trip length check proves. */
function fakeVideo(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "video/mp4" });
}

beforeAll(async () => {
  await seed();
  server = serve({ fetch: createApp().fetch, port: 0 });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  installBrowserGlobals(origin);
  await signIn(SEED.userA.email, SEED_PASSWORD);
}, 60_000);

afterAll(async () => {
  server?.close();
  await closeProgressListener();
  await closePool();
});

describe("projects", () => {
  it("creates, lists, reads and deletes", async () => {
    const created = await db.createProject("Contract test project");
    expect(created).toMatchObject({ name: "Contract test project" });
    expect(typeof created.created_at).toBe("string");
    // Desktop stores ISO-8601 strings because SQLite has no date type; the API
    // serializes `timestamptz` back to the same shape, so `db.ts` still sees
    // a string it can hand to `new Date()`.
    expect(Number.isNaN(Date.parse(created.created_at))).toBe(false);

    const listed = await db.listProjects();
    expect(listed.map((project) => project.id)).toContain(created.id);
    // Seeded project is the active org's; that is what `HomeView` renders.
    expect(listed.map((project) => project.id)).toContain(SEED.projectA.id);

    expect(await db.getProject(created.id)).toMatchObject({ id: created.id });

    await db.deleteProject(created.id);
    expect(await db.getProject(created.id)).toBeNull();
  });

  it("resolves a missing project to null rather than rejecting", async () => {
    // The contract desktop's `Option<Project>` sets: not-found and a real
    // failure must stay distinguishable.
    expect(await db.getProject("no-such-project")).toBeNull();
  });

  it("rejects an empty name", async () => {
    await expect(db.createProject("   ")).rejects.toThrow(/must not be empty/);
  });
});

describe("upload (D1)", () => {
  it("uploads a small file in one PUT and plays it back (D2)", async () => {
    const project = await db.createProject("Single-PUT upload");
    const size = 32 * 1024;
    const [video] = await db.importVideos(project.id, [fakeVideo("small clip.mp4", size)]);

    expect(video.project_id).toBe(project.id);
    // The key ends with the uploaded filename, which is what
    // `basename(video.file_path)` renders in the UI.
    expect(video.file_path.endsWith("/small clip.mp4")).toBe(true);
    // Never a URL and never a bucket hostname — plan §3.4 rule 1.
    expect(video.file_path).not.toMatch(/^https?:/);
    expect(video.duration).toBeNull();

    const url = await db.getPlaybackUrl(video.file_path);
    const played = await fetch(url);
    expect(played.status).toBe(200);
    expect(Number(played.headers.get("content-length"))).toBe(size);

    await db.deleteProject(project.id);
  });

  it("uploads a file larger than the part size in parts", async () => {
    // M3's "done when": a multi-GB file uploads from the browser in parts.
    // 65 MiB is the smallest file that genuinely takes that path — one full
    // 64 MiB part plus a remainder — so the mechanism is exercised without
    // moving gigabytes through CI.
    const project = await db.createProject("Multipart upload");
    const size = PART_SIZE + 1024 * 1024;
    const [video] = await db.importVideos(project.id, [fakeVideo("big lecture.mp4", size)]);

    // The parts were reassembled into one object of exactly the right length,
    // which is the only real proof the split and the ETag round-trip worked.
    const url = await db.getPlaybackUrl(video.file_path);
    const played = await fetch(url, { headers: { range: "bytes=0-15" } });
    expect(played.status).toBe(206);
    expect(played.headers.get("content-range")).toBe(`bytes 0-15/${size}`);

    await db.deleteProject(project.id);
  }, 120_000);

  it("refuses to mint a playback URL for another tenant's key", async () => {
    // The endpoint resolves the key against the caller's own rows instead of
    // signing what it is handed; RLS makes another org's key match nothing.
    const foreignKey = `${SEED.orgB.id}/${SEED.projectB.id}/${SEED.videoB.id}/week-1-lecture.mp4`;
    await expect(db.getPlaybackUrl(foreignKey)).rejects.toMatchObject({ status: 404 });
  });
});

describe("videos", () => {
  it("lists, reads, errors and deletes", async () => {
    const videos = await db.listVideos(SEED.projectA.id);
    expect(videos.map((video) => video.id)).toEqual([SEED.videoA.id]);

    const video = await db.getVideo(SEED.videoA.id);
    expect(video).toMatchObject({ id: SEED.videoA.id, transcript_status: "transcribed" });
    expect(await db.getVideo("no-such-video")).toBeNull();

    const project = await db.createProject("Disposable");
    const [created] = await db.importVideos(project.id, [fakeVideo("clip.mp4", 1024)]);
    await db.markVideoError(created.id);
    expect((await db.getVideo(created.id))?.transcript_status).toBe("error");

    await db.deleteVideo(created.id);
    expect(await db.getVideo(created.id)).toBeNull();
    await db.deleteProject(project.id);
  });
});

describe("pipeline (D3)", () => {
  it("queues each stage and returns immediately", async () => {
    const project = await db.createProject("Pipeline");
    const [video] = await db.importVideos(project.id, [fakeVideo("lecture.mp4", 4096)]);

    // Desktop resolves these when the work is done; here they resolve when the
    // job is queued, and completion arrives on the progress stream. The row
    // comes back unchanged, `audio_path` still null — nothing has run.
    const afterExtract = await db.extractAudioForVideo(video.id, 1);
    expect(afterExtract.id).toBe(video.id);
    expect(afterExtract.audio_path).toBeNull();

    const afterTranscribe = await db.transcribeVideo(video.id, 2);
    expect(afterTranscribe.id).toBe(video.id);

    // A fresh video has no lessons yet; the worker's analysis writes them.
    expect(await db.analyzeVideo(video.id, 1)).toEqual([]);

    await db.deleteProject(project.id);
  });

  it("refuses to extract from a video whose upload never finished", async () => {
    const project = await db.createProject("Half-uploaded");
    // Deliberately at the transport level: `importVideos` always completes the
    // upload, so the only way to reach a `pending` row is to stop halfway —
    // which is exactly what a browser tab closing mid-upload does.
    const ticket = await fetch(`/api/projects/${project.id}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "abandoned.mp4", size: 1024, content_type: "video/mp4" }),
    }).then((response) => response.json() as Promise<{ video_id: string }>);

    await expect(db.extractAudioForVideo(ticket.video_id, 1)).rejects.toThrow(
      /has not finished uploading/,
    );
    await db.deleteProject(project.id);
  });
});

describe("progress stream (D4)", () => {
  it("delivers a VideoProgress frame when a job is queued", async () => {
    // Read with a streaming `fetch` rather than through
    // `subscribeProgress`: that helper uses `EventSource`, which Node has no
    // implementation of, and emulating one would test the emulation. What
    // matters to `useVideoProgress` is the wire format — the event name and
    // the payload's fields — and that is what is asserted here.
    const stream = await fetch("/api/progress", { headers: { accept: "text/event-stream" } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();

    const project = await db.createProject("Progress");
    const [video] = await db.importVideos(project.id, [fakeVideo("lecture.mp4", 2048)]);
    await db.extractAudioForVideo(video.id, 3);

    let buffered = "";
    let frame: string | undefined;
    while (!frame) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      frame = buffered.split("\n\n").find((chunk) => chunk.includes("event: video-progress"));
    }
    await reader.cancel();

    expect(frame).toBeDefined();
    const data = JSON.parse(
      frame!
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice("data: ".length),
    );
    // Exactly desktop's `VideoProgress`, which is why `useVideoProgress` needs
    // no change beyond its subscription line.
    expect(data).toEqual({
      video_id: video.id,
      stage: "ExtractingAudio",
      fraction: null,
      detail: "Extracting audio",
      attempt: 3,
    });
    // The org never leaves the server — the browser is already scoped by its
    // session and has nowhere to put it.
    expect(data).not.toHaveProperty("org_id");

    await db.deleteProject(project.id);
  }, 30_000);

  it("requires a session", async () => {
    // An unauthenticated EventSource must not open a stream that then sits
    // there delivering nothing; it has to fail loudly.
    clearCookies();
    const denied = await fetch("/api/progress", { headers: { accept: "text/event-stream" } });
    expect(denied.status).toBe(401);
    await signIn(SEED.userA.email, SEED_PASSWORD);
  });
});

describe("transcript", () => {
  it("lists segments and toggles keep without deleting rows", async () => {
    const segments = await db.listTranscriptSegments(SEED.videoA.id);
    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => segment.keep)).toEqual([true, false, true]);

    const updated = await db.updateTranscriptSegment(segments[1].id, true);
    expect(updated.keep).toBe(true);
    // The text survives — "removing" a segment in Transcript Mode is a flag,
    // never a row delete, so it can be put back.
    expect(updated.text).toBe(segments[1].text);

    await db.updateTranscriptSegment(segments[1].id, false);
    expect(await db.listTranscriptSegments(SEED.videoA.id)).toHaveLength(3);
  });
});

describe("lessons", () => {
  it("creates a manual lesson from non-contiguous ranges", async () => {
    const lesson = await db.createLesson(SEED.videoA.id, "Manual lesson", [
      { start: 100, end: 200 },
      { start: 300, end: 400 },
    ]);
    expect(lesson).toMatchObject({ title: "Manual lesson", source: "manual", confidence: null });
    // start/end are the cached bound across the segments, not a range of the
    // lesson's own — min start, max end.
    expect(lesson.start).toBe(100);
    expect(lesson.end).toBe(400);

    const segments = await db.listLessonSegments(lesson.id);
    expect(segments.map((segment) => [segment.start, segment.end])).toEqual([
      [100, 200],
      [300, 400],
    ]);

    await db.deleteLesson(lesson.id);
  });

  it("rejects a lesson with no segments or an empty title", async () => {
    await expect(db.createLesson(SEED.videoA.id, "No segments", [])).rejects.toThrow(
      /at least one segment/,
    );
    await expect(
      db.createLesson(SEED.videoA.id, "  ", [{ start: 0, end: 10 }]),
    ).rejects.toThrow(/must not be empty/);
  });

  it("updates title and summary with patch semantics", async () => {
    const lesson = await db.createLesson(SEED.videoA.id, "Before", [{ start: 0, end: 10 }]);
    const withSummary = await db.updateLesson(lesson.id, { summary: "A summary" });
    expect(withSummary).toMatchObject({ title: "Before", summary: "A summary" });

    const renamed = await db.updateLesson(lesson.id, { title: "After" });
    // The omitted field is untouched, not cleared.
    expect(renamed).toMatchObject({ title: "After", summary: "A summary" });

    await db.deleteLesson(lesson.id);
  });

  it("splits a lesson at a time inside one of its segments", async () => {
    const lesson = await db.createLesson(SEED.videoA.id, "Splittable", [{ start: 0, end: 100 }]);
    const [segment] = await db.listLessonSegments(lesson.id);

    const [original, tail] = await db.splitLesson(lesson.id, segment.id, 40);
    expect(original).toMatchObject({ id: lesson.id, start: 0, end: 40 });
    expect(tail.title).toBe("Splittable (cont.)");
    expect(tail).toMatchObject({ start: 40, end: 100, source: "manual" });

    await expect(db.splitLesson(lesson.id, segment.id, 0)).rejects.toThrow(/strictly between/);

    await db.deleteLesson(original.id);
    await db.deleteLesson(tail.id);
  });

  it("merges two lessons by concatenating their segments", async () => {
    const first = await db.createLesson(SEED.videoA.id, "First", [{ start: 0, end: 10 }]);
    await db.updateLesson(first.id, { summary: "First summary" });
    const second = await db.createLesson(SEED.videoA.id, "Second", [{ start: 50, end: 60 }]);
    await db.updateLesson(second.id, { summary: "Second summary" });

    const merged = await db.mergeLessons(first.id, second.id);
    expect(merged.title).toBe("First");
    expect(merged.summary).toBe("First summary\nSecond summary");
    expect(merged.start).toBe(0);
    expect(merged.end).toBe(60);
    expect(await db.listLessonSegments(merged.id)).toHaveLength(2);

    // The second lesson is gone, not emptied.
    expect((await db.listLessons(SEED.videoA.id)).map((l) => l.id)).not.toContain(second.id);
    await db.deleteLesson(merged.id);
  });

  it("reorders a video's lessons all-or-nothing", async () => {
    const a = await db.createLesson(SEED.videoA.id, "Order A", [{ start: 500, end: 600 }]);
    const b = await db.createLesson(SEED.videoA.id, "Order B", [{ start: 700, end: 800 }]);
    const ids = (await db.listLessons(SEED.videoA.id)).map((lesson) => lesson.id);

    await db.reorderLessons(SEED.videoA.id, [...ids].reverse());
    const reordered = await db.listLessons(SEED.videoA.id);
    expect(reordered.map((lesson) => lesson.id)).toEqual([...ids].reverse());

    // A partial list is refused rather than silently applied.
    await expect(db.reorderLessons(SEED.videoA.id, [a.id])).rejects.toThrow(/exactly match/);
    await expect(db.reorderLessons(SEED.videoA.id, [a.id, a.id, b.id])).rejects.toThrow(
      /duplicate/,
    );

    await db.deleteLesson(a.id);
    await db.deleteLesson(b.id);
    // Put the seeded lesson back at the front.
    await db.reorderLessons(SEED.videoA.id, [SEED.lessonA.id]);
  });
});

describe("lesson segments", () => {
  it("adds, updates and reorders segments, resyncing the cached bound", async () => {
    const lesson = await db.createLesson(SEED.videoA.id, "Segmented", [{ start: 10, end: 20 }]);

    const added = await db.addLessonSegment(lesson.id, 30, 45);
    expect(added.sort_order).toBe(1);
    expect((await db.listLessons(SEED.videoA.id)).find((l) => l.id === lesson.id)).toMatchObject({
      start: 10,
      end: 45,
    });

    const widened = await db.updateLessonSegment(added.id, 30, 90);
    expect(widened.end).toBe(90);
    expect((await db.listLessons(SEED.videoA.id)).find((l) => l.id === lesson.id)?.end).toBe(90);

    const segments = await db.listLessonSegments(lesson.id);
    await db.reorderLessonSegments(lesson.id, [segments[1].id, segments[0].id]);
    expect((await db.listLessonSegments(lesson.id)).map((s) => s.id)).toEqual([
      segments[1].id,
      segments[0].id,
    ]);
    // Reordering moves playback sequence only — the bound cannot have changed.
    expect((await db.listLessons(SEED.videoA.id)).find((l) => l.id === lesson.id)).toMatchObject({
      start: 10,
      end: 90,
    });

    await expect(db.addLessonSegment(lesson.id, 50, 50)).rejects.toThrow(/must be before/);
    await db.deleteLesson(lesson.id);
  });

  it("deletes the lesson when its last segment goes", async () => {
    const lesson = await db.createLesson(SEED.videoA.id, "Doomed", [
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);
    const segments = await db.listLessonSegments(lesson.id);

    const first = await db.deleteLessonSegment(segments[0].id);
    expect(first).toEqual({ lesson_id: lesson.id, lesson_deleted: false });

    const last = await db.deleteLessonSegment(segments[1].id);
    expect(last).toEqual({ lesson_id: lesson.id, lesson_deleted: true });
    expect((await db.listLessons(SEED.videoA.id)).map((l) => l.id)).not.toContain(lesson.id);
  });

  it("applies an AI segment edit, and refuses one that empties the lesson", async () => {
    const lesson = await db.createLesson(SEED.videoA.id, "Editable", [{ start: 0, end: 100 }]);

    const applied = await db.applyLessonSegmentEdit(lesson.id, [
      { start: 5, end: 40 },
      { start: 60, end: 95 },
    ]);
    expect(applied.map((segment) => [segment.start, segment.end])).toEqual([
      [5, 40],
      [60, 95],
    ]);

    await expect(db.applyLessonSegmentEdit(lesson.id, [])).rejects.toThrow(/at least one segment/);
    await db.deleteLesson(lesson.id);
  });

  it("refuses to propose an edit with nothing to act on", async () => {
    // M3 refused this route outright, because proposing needs a live model
    // inside the request and the model code arrived at M5. It works now, and
    // `pipeline.test.ts` exercises it end to end against a stubbed OpenAI.
    //
    // What stays here is the half of the contract that needs no model: an
    // empty instruction is rejected before anything is sent, which is both
    // desktop's behaviour and the difference between "you didn't say what you
    // wanted" and a bill for asking the model nothing.
    await expect(db.previewLessonSegmentEdit(SEED.lessonA.id, "   ")).rejects.toThrow(
      /Describe the change/,
    );
  });
});

describe("settings", () => {
  it("round-trips per-org analysis instructions", async () => {
    expect(await db.getAnalysisInstructions()).toBe(
      "Prefer shorter lessons; split at topic changes.",
    );

    await db.saveAnalysisInstructions("Keep lessons under ten minutes.");
    expect(await db.getAnalysisInstructions()).toBe("Keep lessons under ten minutes.");
  });

  it("has no OpenAI key surface at all (D7)", async () => {
    // Not a stub returning "no key saved" — the routes do not exist, because
    // the key is platform-owned and never per-tenant. A 404 here is the
    // assertion that D7 was implemented by removal rather than by hiding.
    for (const path of ["/api/settings/openai-key", "/api/settings/openai-key/test"]) {
      expect((await fetch(path, { method: "GET" })).status).toBe(404);
    }
  });
});

describe("exports (D5, D6)", () => {
  it("queues, transitions, lists and hands back a download URL", async () => {
    const [queued] = await db.queueExport([SEED.lessonA.id], await db.pickExportDirectory() ?? "");
    expect(queued).toMatchObject({ lesson_id: SEED.lessonA.id, status: "queued", progress: 0 });
    // D5: an object key, not a local path, and unique by the export's own id.
    expect(queued.output_path).toContain(`/exports/${queued.id}/`);
    expect(queued.output_path.endsWith(".mp4")).toBe(true);

    expect((await db.pauseExport(queued.id)).status).toBe("paused");
    // Pause only ever applies to a job that has not started encoding.
    await expect(db.pauseExport(queued.id)).rejects.toThrow(/only a queued export/);
    expect((await db.resumeExport(queued.id)).status).toBe("queued");
    expect((await db.cancelExport(queued.id)).status).toBe("cancelled");
    expect((await db.retryExport(queued.id)).status).toBe("queued");

    const listed = await db.listExports(SEED.projectA.id);
    const row = listed.find((entry) => entry.id === queued.id);
    // Export History renders ancestry without a round trip per row.
    expect(row).toMatchObject({
      lesson_title: "What is a relation?",
      lesson_start: 0,
      lesson_end: 58.25,
    });
    expect(row?.video_file_path).toContain(SEED.videoA.id);

    // D6: no finished object yet, so there is nothing to hand over.
    await expect(db.revealInFolder(queued.output_path)).rejects.toThrow(/has not finished/);
    expect(lastOpenedUrl).toBeNull();

    await db.cancelExport(queued.id);
  });

  it("rejects an empty batch", async () => {
    await expect(db.queueExport([], "")).rejects.toThrow(/no lessons selected/);
  });
});

describe("tenant isolation, through the client", () => {
  it("shows a second tenant none of the first's data", async () => {
    // The isolation suite proves RLS at the SQL layer. This proves the API
    // above it never widens the hole — same client, different session.
    clearCookies();
    await signIn(SEED.userB.email, SEED_PASSWORD);

    const projects = await db.listProjects();
    expect(projects.map((project) => project.id)).toEqual([SEED.projectB.id]);

    expect(await db.getProject(SEED.projectA.id)).toBeNull();
    expect(await db.getVideo(SEED.videoA.id)).toBeNull();
    expect(await db.listTranscriptSegments(SEED.videoA.id)).toEqual([]);
    expect(await db.listLessons(SEED.videoA.id)).toEqual([]);
    expect(await db.listExports(SEED.projectA.id)).toEqual([]);
    await expect(db.deleteLesson(SEED.lessonA.id)).rejects.toMatchObject({ status: 404 });

    // Analysis instructions are per-org, so the other tenant's are invisible.
    expect(await db.getAnalysisInstructions()).toBeNull();
  });

  it("survives a refused org switch instead of locking the user out", async () => {
    // Regression, and a nastier one than it looks. `better-auth`'s
    // `set-active` correctly refuses a switch to an org the user does not
    // belong to — and clears the session's active org while doing it. Before
    // `requireOrg` learned to re-adopt a default, that refusal cost the user
    // access to the org they were already in until they signed out.
    clearCookies();
    await signIn(SEED.userB.email, SEED_PASSWORD);
    expect((await db.listProjects()).map((project) => project.id)).toEqual([SEED.projectB.id]);

    const refused = await fetch("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: SEED.orgA.id }),
    });
    expect(refused.status).toBe(403);

    // Still signed in, still in their own org, still seeing their own data.
    expect((await db.listProjects()).map((project) => project.id)).toEqual([SEED.projectB.id]);
  });

  it("refuses a request with no session at all", async () => {
    clearCookies();
    await expect(db.listProjects()).rejects.toBeInstanceOf(ApiError);
    await expect(db.listProjects()).rejects.toMatchObject({ status: 401 });
  });
});
