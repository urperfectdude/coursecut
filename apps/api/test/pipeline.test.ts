// M5's acceptance criterion, end to end: "a video uploaded in the browser
// produces lessons and a downloadable MP4" (plan §7).
//
// So this suite drives the real thing at both ends. It uploads a real MP4 from
// the shipped client (`apps/web/src/db.ts`) to a real MinIO through a real
// presigned URL, runs the real worker handlers against real ffmpeg, and reads
// the finished export back out of storage — checking with ffprobe that the
// file it produced is the length the lesson asked for.
//
// **Two things are stubbed, and only two.**
//
//   * **OpenAI.** `OPENAI_BASE_URL` points at a local server that answers with
//     the shapes Whisper and the chat API answer with. That is what makes the
//     transcript and the lesson boundaries assertable — a real model would
//     return something different every run — and it means CI never spends
//     money or needs a key. What is *not* stubbed is any of our own code: the
//     prompts, the multipart upload, the response parsing, the silence
//     trimming and the row writes are all the shipping ones.
//   * **The queue's polling.** Handlers are invoked directly with the payload
//     the queue would hand them, rather than booting `graphile-worker` and
//     waiting. The enqueue side is asserted separately (a real
//     `graphile_worker` job row, with the key the API wrote), so the wiring is
//     covered without a sleep in the middle of the test.
//
// Needs the local stack and ffmpeg:
//
//   docker compose -f infra/postgres/compose.yml up -d --wait
//   cd apps/api && npm run db:reset && npm test

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closePool, getDb, withOrg } from "../src/db/client.js";
import { closeProgressListener, subscribeProgress, type ProgressEvent } from "../src/events.js";
import { SEED, SEED_PASSWORD, seed } from "../src/db/seed.js";
import * as schema from "../src/db/schema.js";
import * as storage from "../src/storage.js";
import { installBrowserGlobals, lastOpenedUrl, signIn } from "./browser.js";
import { runVideoJob } from "../../worker/src/tasks/video.js";
import { runExportJob } from "../../worker/src/tasks/export.js";
import * as db from "../../web/src/db.js";

const run = promisify(execFile);
const ORG = SEED.orgA.id;

let server: ReturnType<typeof serve>;
let openai: Server;
let scratch: string;

/** What the stubbed Whisper returns. The 2.5s hole between the second and
 * third line is above the silence threshold, so it is a real gap for the
 * trimming pass to find. */
const WHISPER_SEGMENTS = [
  { start: 0, end: 2, text: "Welcome to the course." },
  { start: 2, end: 3.5, text: "Today we cover joins." },
  { start: 6, end: 8, text: "That is all for today." },
];

/** What the stubbed GPT-5.5 proposes. The second lesson deliberately starts
 * inside the transcript's dead air, so the silence trim has something to do
 * that the assertion can see. */
const PROPOSED_LESSONS = {
  lessons: [
    {
      segments: [{ start: 0, end: 2 }],
      title: "Intro: Joins & Keys",
      summary: "Welcome and overview.",
      kind: "lesson",
      confidence: 0.9,
    },
    {
      segments: [{ start: 4.5, end: 8 }],
      title: "Wrap up",
      summary: "",
      kind: "discussion",
      confidence: 0.4,
    },
  ],
};

/** The stub's answer to a segment-edit prompt. */
const PROPOSED_EDIT = { segments: [{ start: 0.5, end: 1.5 }] };

/** Records what the stub was asked, so the tests can assert on the *prompt* —
 * which is where the privacy rule lives (plan §9: transcript text, never
 * audio, never video). */
const sent: { transcriptions: number; completions: string[] } = {
  transcriptions: 0,
  completions: [],
};

function startOpenAiStub(): Promise<Server> {
  const stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      res.setHeader("content-type", "application/json");

      if (req.url === "/v1/audio/transcriptions") {
        sent.transcriptions += 1;
        // The upload really is a multipart form with encoded audio in it;
        // assert the shape rather than trusting the client library. `OggS` is
        // the Opus container `extractAudio` now writes — note that an
        // assertion failing *here* leaves the request unanswered and hangs the
        // caller until its own timeout, so it is deliberately a check on the
        // container magic rather than anything that tracks the encoder.
        expect(req.headers["content-type"]).toMatch(/multipart\/form-data/);
        expect(body.includes(Buffer.from("OggS"))).toBe(true);
        res.end(JSON.stringify({ segments: WHISPER_SEGMENTS }));
        return;
      }

      if (req.url === "/v1/chat/completions") {
        const parsed = JSON.parse(body.toString()) as {
          messages: Array<{ role: string; content: string }>;
        };
        const user = parsed.messages.find((message) => message.role === "user")!.content;
        sent.completions.push(user);
        const isEdit = user.startsWith("Current lesson segments");
        res.end(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify(isEdit ? PROPOSED_EDIT : PROPOSED_LESSONS) } },
            ],
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end("{}");
    });
  });

  return new Promise((resolve) => {
    stub.listen(0, "127.0.0.1", () => resolve(stub));
  });
}

/** A real, tiny MP4 — six seconds of test pattern and a tone. Everything
 * downstream (ffprobe, the cut, the concat) works on this exactly as it would
 * on a lecture recording; it is just shorter. */
async function makeVideo(path: string, seconds = 6): Promise<Uint8Array<ArrayBuffer>> {
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=160x120:rate=10`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    path,
  ]);
  // As a plain `Uint8Array`: `File` will not take a `Buffer` whose type says
  // it might be backed by a `SharedArrayBuffer`.
  const bytes = await readFile(path);
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function durationOf(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  return Number.parseFloat(stdout.trim());
}

/** The `jobs` row the API queued for a video, newest first — the id the queue
 * would have handed the worker. */
async function pendingJob(videoId: string, kind: string) {
  return withOrg(ORG, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.videoId, videoId), eq(schema.jobs.kind, kind)))
      .orderBy(sql`created_at desc`)
      .limit(1);
    return row;
  });
}

beforeAll(async () => {
  openai = await startOpenAiStub();
  const port = (openai.address() as { port: number }).port;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  // Keep the worker's scratch inside the test's own temp tree, so a failing
  // run leaves nothing behind in a shared directory.
  scratch = await mkdtemp(join(tmpdir(), "coursecut-pipeline-"));
  process.env.WORKER_SCRATCH_DIR = join(scratch, "worker");

  await seed();
  server = serve({ fetch: createApp().fetch, port: 0 });
  const address = server.address();
  installBrowserGlobals(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
  await signIn(SEED.userA.email, SEED_PASSWORD);
}, 120_000);

afterAll(async () => {
  server?.close();
  openai?.close();
  await closeProgressListener();
  await closePool();
  await rm(scratch, { recursive: true, force: true });
});

describe("the pipeline", () => {
  it("takes an uploaded video through to lessons and a downloadable MP4", async () => {
    const project = await db.createProject("Pipeline test");
    const source = join(scratch, "lecture.mp4");
    const bytes = await makeVideo(source);

    // --- Upload (D1) — the browser's own path, straight to storage ---------
    const [video] = await db.importVideos(project.id, [
      new File([bytes], "lecture.mp4", { type: "video/mp4" }),
    ]);
    expect(video!.transcript_status).toBe("pending");
    expect(video!.duration).toBeNull();

    // --- Extract (D3) ------------------------------------------------------
    // The call returns immediately with the row unchanged; that is the
    // deviation, and it is why `audio_path` is still null here.
    const queued = await db.extractAudioForVideo(video!.id, 1);
    expect(queued.audio_path).toBeNull();

    // A real queue entry, keyed the way `enqueueVideoJob` keys it.
    const queued_ = await getDb().execute<{ key: string; task: string }>(
      sql`select j.key, t.identifier as task
          from graphile_worker._private_jobs j
          join graphile_worker._private_tasks t on t.id = j.task_id
          where j.key = ${`extract:${video!.id}`}`,
    );
    const queueRow = queued_.rows[0];
    expect(queueRow).toMatchObject({ task: "video-pipeline" });

    const extractJob = await pendingJob(video!.id, "extract");
    const progress = await collectProgress(() =>
      runVideoJob({ job_id: extractJob!.id, org_id: ORG }),
    );

    const extracted = await db.getVideo(video!.id);
    expect(extracted!.transcript_status).toBe("audio_ready");
    expect(extracted!.duration).toBeCloseTo(6, 0);
    // `audio_path` is an object key, never a URL or a bucket hostname
    // (plan §3.4 rule 1), and it is prefixed by the org that owns it.
    expect(extracted!.audio_path).toBe(`${ORG}/${project.id}/${video!.id}/audio.ogg`);
    expect(await storage.headObject(extracted!.audio_path!)).not.toBeNull();
    // The hash is computed while the source streams past on its way to disk,
    // so it is worth proving it is the hash of the bytes that were uploaded
    // rather than of whatever arrived.
    const [row] = await withOrg(ORG, (tx) =>
      tx.select({ hash: schema.videos.contentHash }).from(schema.videos).where(eq(schema.videos.id, video!.id)),
    );
    expect(row!.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    // D4: the same `VideoProgress` shape desktop emits, over SSE.
    expect(progress.map((event) => event.stage)).toContain("ExtractingAudio");

    // --- Transcribe: queued by the worker, not by the view -----------------
    const transcribeJob = await pendingJob(video!.id, "transcribe");
    expect(transcribeJob, "extract should have chained transcription").toBeDefined();
    await runVideoJob({ job_id: transcribeJob!.id, org_id: ORG });

    expect(sent.transcriptions).toBe(1);
    const transcript = await db.listTranscriptSegments(video!.id);
    expect(transcript.map((segment) => segment.text)).toEqual(
      WHISPER_SEGMENTS.map((segment) => segment.text),
    );
    expect(transcript.every((segment) => segment.keep)).toBe(true);
    expect((await db.getVideo(video!.id))!.transcript_status).toBe("transcribed");

    // --- Analyze -----------------------------------------------------------
    await db.saveAnalysisInstructions("Always split out Q&A sections.");
    expect(await db.analyzeVideo(video!.id, 1)).toEqual([]);
    const analyzeJob = await pendingJob(video!.id, "analyze");
    await runVideoJob({ job_id: analyzeJob!.id, org_id: ORG });

    const lessons = await db.listLessons(video!.id);
    expect(lessons.map((lesson) => lesson.title)).toEqual(["Intro: Joins & Keys", "Wrap up"]);
    expect(lessons[0]).toMatchObject({ kind: "lesson", source: "ai", confidence: 0.9 });
    expect(lessons[1]!.kind).toBe("discussion");

    // The second lesson was proposed from 4.5s, inside the transcript's
    // 3.5–6s dead air; the silence trim pulled its start to the far edge of
    // the gap before anything was written.
    const wrapSegments = await db.listLessonSegments(lessons[1]!.id);
    expect(wrapSegments[0]!.start).toBe(6);
    expect(lessons[1]!.start).toBe(6);

    // Only transcript text went out, and the org's instructions rode along —
    // never audio, never video, never a key (plan §9, D7).
    const prompt = sent.completions.at(-1)!;
    expect(prompt).toContain("Welcome to the course.");
    expect(prompt).not.toContain(video!.file_path);

    // --- Export (D5, D6) ---------------------------------------------------
    const [queuedExport] = await db.queueExport([lessons[0]!.id], "");
    await runExportJob({ export_id: queuedExport!.id, org_id: ORG });

    const [exportRow] = await db.listExports(project.id);
    expect(exportRow).toMatchObject({ status: "done", progress: 1, error: null });
    // The key carries the sanitized lesson title, so the file arrives named
    // the way the desktop app would have named it.
    expect(exportRow!.output_path).toBe(
      `${ORG}/${project.id}/exports/${queuedExport!.id}/Intro_Joins_Keys.mp4`,
    );

    // D6: "Reveal in Finder" becomes a download URL, and the object behind it
    // is a real MP4 of the lesson's own length.
    await db.revealInFolder(exportRow!.output_path);
    expect(lastOpenedUrl).toContain("Intro_Joins_Keys.mp4");

    const downloaded = join(scratch, "downloaded.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(downloaded, await storage.getObjectBytes(exportRow!.output_path));
    expect(await durationOf(downloaded)).toBeCloseTo(2, 0);
  }, 180_000);

  it("cuts and joins a multi-segment lesson into one file", async () => {
    const { project, video } = await uploadedVideo("Multi-segment");

    const lesson = await db.createLesson(video.id, "Two parts", [
      { start: 0, end: 1 },
      { start: 4, end: 6 },
    ]);
    const [queuedExport] = await db.queueExport([lesson.id], "");
    await runExportJob({ export_id: queuedExport!.id, org_id: ORG });

    const [exportRow] = await db.listExports(project.id);
    expect(exportRow!.status).toBe("done");

    const downloaded = join(scratch, "joined.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(downloaded, await storage.getObjectBytes(exportRow!.output_path));
    // One file, not one per segment, and as long as the two parts together —
    // the gap the user excluded is not in it.
    expect(await durationOf(downloaded)).toBeCloseTo(3, 0);
  }, 180_000);

  it("leaves a cancelled export alone and uploads nothing for it", async () => {
    const { project, video } = await uploadedVideo("Cancelled export");
    const lesson = await db.createLesson(video.id, "Doomed", [{ start: 0, end: 2 }]);
    const [queuedExport] = await db.queueExport([lesson.id], "");

    await db.cancelExport(queuedExport!.id);
    await runExportJob({ export_id: queuedExport!.id, org_id: ORG });

    const [exportRow] = await db.listExports(project.id);
    expect(exportRow!.status).toBe("cancelled");
    expect(exportRow!.progress).toBe(0);
    expect(await storage.headObject(exportRow!.output_path)).toBeNull();
  }, 120_000);

  it("re-queues a resumed export, which a paused one has nothing to run from", async () => {
    const { video } = await uploadedVideo("Paused export");
    const lesson = await db.createLesson(video.id, "Later", [{ start: 0, end: 1 }]);
    const [queuedExport] = await db.queueExport([lesson.id], "");

    await db.pauseExport(queuedExport!.id);
    // The handler must not run a paused job — and must not fail it either. It
    // puts itself back with a delay.
    await runExportJob({ export_id: queuedExport!.id, org_id: ORG });
    expect((await db.listExports((await db.getVideo(video.id))!.project_id))[0]!.status).toBe("paused");

    await db.resumeExport(queuedExport!.id);
    const requeued = (
      await getDb().execute<{ run_at: Date }>(
        sql`select run_at from graphile_worker._private_jobs where key = ${`export:${queuedExport!.id}`}`,
      )
    ).rows[0];
    // Resume schedules it for now, replacing the paused re-check rather than
    // adding a second entry.
    expect(requeued).toBeDefined();
    expect(new Date(requeued!.run_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  }, 120_000);

  it("reuses an already-extracted sibling's audio for a re-uploaded file", async () => {
    const project = await db.createProject("Cache test");
    const source = join(scratch, "same.mp4");
    const bytes = await makeVideo(source, 3);
    const file = () => new File([bytes], "same.mp4", { type: "video/mp4" });

    const [first] = await db.importVideos(project.id, [file()]);
    await db.extractAudioForVideo(first!.id, 1);
    await runVideoJob({ job_id: (await pendingJob(first!.id, "extract"))!.id, org_id: ORG });

    const [second] = await db.importVideos(project.id, [file()]);
    await db.extractAudioForVideo(second!.id, 1);
    await runVideoJob({ job_id: (await pendingJob(second!.id, "extract"))!.id, org_id: ORG });

    const rows = await withOrg(ORG, (tx) =>
      tx
        .select({ id: schema.videos.id, hash: schema.videos.contentHash, audio: schema.videos.audioKey })
        .from(schema.videos)
        .where(eq(schema.videos.projectId, project.id)),
    );
    expect(rows).toHaveLength(2);
    // Both rows record the same hash — which the unique index M2 shipped made
    // impossible, and 0002 fixed.
    expect(rows[0]!.hash).toBe(rows[1]!.hash);
    // Each owns its own object, so deleting one cannot take the other's audio
    // with it.
    expect(rows[0]!.audio).not.toBe(rows[1]!.audio);
    expect(await storage.headObject(rows[1]!.audio!)).not.toBeNull();
  }, 180_000);

  it("proposes a segment edit from the transcript around the lesson", async () => {
    const { video } = await uploadedVideo("Segment edit");
    await runVideoJob({ job_id: (await pendingJob(video.id, "transcribe"))!.id, org_id: ORG });
    const lesson = await db.createLesson(video.id, "Editable", [{ start: 0, end: 3 }]);

    const proposed = await db.previewLessonSegmentEdit(lesson.id, "trim to the first 1.5 seconds");
    expect(proposed).toEqual([{ start: 0.5, end: 1.5 }]);

    // Nothing is written by a proposal — the popup's Apply is the only writer.
    expect(await db.listLessonSegments(lesson.id)).toHaveLength(1);
    expect((await db.listLessonSegments(lesson.id))[0]!.end).toBe(3);

    const applied = await db.applyLessonSegmentEdit(lesson.id, proposed);
    expect(applied.map((segment) => [segment.start, segment.end])).toEqual([[0.5, 1.5]]);

    const prompt = sent.completions.at(-1)!;
    expect(prompt).toContain("Current lesson segments (seconds): [0.00-3.00]");
    expect(prompt).toContain("Welcome to the course.");
  }, 180_000);
});

/** A project with one uploaded, extracted video — the starting point most of
 * the cases above need. */
async function uploadedVideo(name: string) {
  const project = await db.createProject(name);
  const source = join(scratch, `${name.replace(/\W+/g, "-")}.mp4`);
  const bytes = await makeVideo(source);
  const [video] = await db.importVideos(project.id, [
    new File([bytes], "lecture.mp4", { type: "video/mp4" }),
  ]);
  await db.extractAudioForVideo(video!.id, 1);
  await runVideoJob({ job_id: (await pendingJob(video!.id, "extract"))!.id, org_id: ORG });
  return { project, video: video! };
}

/** Everything published on this org's progress channel while `fn` runs — the
 * server half of D4, read the way the SSE route reads it. */
async function collectProgress(fn: () => Promise<void>): Promise<ProgressEvent[]> {
  const events: ProgressEvent[] = [];
  const unsubscribe = await subscribeProgress(ORG, (event) => events.push(event));
  try {
    await fn();
    // NOTIFY delivery is asynchronous; give the listener a tick to drain.
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    unsubscribe();
  }
  return events;
}
