// In-memory stand-in for `apps/api`, so the copied UI is verifiable in a
// browser before the real API exists (M1's "done when"). Dev-only and
// dynamically imported — it is not in a production bundle.
//
// It is a UI fixture, not a spec. Two places where it knowingly differs from
// what `apps/api` will do:
//
//  * The pipeline calls (`extract`/`transcribe`/`analyze`) do the work inline
//    with a short delay instead of enqueuing a job (D3). The UI can't tell —
//    it awaits the call and watches the progress stream either way.
//  * Uploaded bytes are kept as an object URL rather than sent anywhere, so
//    playback works locally with the file the user actually picked.
//
// Anything else that diverges is a bug in this file, not a licence for the
// UI to depend on it.

import type {
  DeleteLessonSegmentResult,
  ExportRow,
  Lesson,
  LessonSegment,
  LessonSegmentRange,
  Project,
  TranscriptSegment,
  Video,
  VideoProgress,
} from "../db";

/** Thrown for a row that doesn't exist, so `requestOrNull` can map it to
 * `null` exactly as a real 404 would. */
export class MockNotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "MockNotFound";
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 8 MiB, not the API's 64 MiB. Small enough that dragging in a modest test
 * clip actually takes the multipart path, which is the only way that code
 * gets exercised outside the contract tests — with the real threshold you
 * would need a 64 MiB fixture to notice it was broken.
 */
const MOCK_PART_SIZE = 8 * 1024 * 1024;

let counter = 0;
const id = (prefix: string) => `${prefix}_${(++counter).toString().padStart(4, "0")}`;
const now = () => new Date().toISOString();

interface Store {
  projects: Project[];
  videos: Video[];
  transcript: TranscriptSegment[];
  lessons: Lesson[];
  segments: LessonSegment[];
  exports: ExportRow[];
  analysisInstructions: string | null;
  /** Object URLs for "uploaded" files, keyed by storage key. */
  blobs: Map<string, string>;
}

function seed(): Store {
  const project: Project = {
    id: id("prj"),
    name: "Intro to Databases — Spring",
    created_at: now(),
    updated_at: now(),
  };
  const empty: Project = {
    id: id("prj"),
    name: "Empty project",
    created_at: now(),
    updated_at: now(),
  };
  const video: Video = {
    id: id("vid"),
    project_id: project.id,
    file_path: `org_demo/${project.id}/vid_seed/Lecture 01 — Relational Model.mp4`,
    duration: 3600,
    transcript_status: "done",
    created_at: now(),
    updated_at: now(),
    audio_path: `org_demo/${project.id}/vid_seed/audio.wav`,
  };
  const transcript: TranscriptSegment[] = Array.from({ length: 40 }, (_, i) => ({
    id: id("seg"),
    video_id: video.id,
    start: i * 90,
    end: (i + 1) * 90,
    text:
      i % 4 === 0
        ? "So let's pick that up from where we stopped last time — the relational model."
        : "…and that constraint is what guarantees the join stays lossless. Any questions on that?",
    keep: true,
  }));
  const lessons: Lesson[] = [
    {
      id: id("les"),
      video_id: video.id,
      title: "Relations, tuples and keys",
      summary: "Defines the relational model and why keys matter.",
      start: 0,
      end: 900,
      sort_order: 0,
      confidence: 0.92,
      kind: "lesson",
      source: "ai",
    },
    {
      id: id("les"),
      video_id: video.id,
      title: "Normal forms, walked through",
      summary: "1NF through 3NF with a worked example.",
      start: 900,
      end: 2400,
      sort_order: 1,
      confidence: 0.71,
      kind: "lesson",
      source: "ai",
    },
    {
      id: id("les"),
      video_id: video.id,
      title: "Q&A on the midterm",
      summary: null,
      start: 2400,
      end: 3000,
      sort_order: 2,
      confidence: 0.44,
      kind: "qna",
      source: "ai",
    },
  ];
  const segments: LessonSegment[] = lessons.map((lesson) => ({
    id: id("lsg"),
    lesson_id: lesson.id,
    start: lesson.start,
    end: lesson.end,
    sort_order: 0,
  }));

  return {
    projects: [project, empty],
    videos: [video],
    transcript,
    lessons,
    segments,
    exports: [],
    analysisInstructions: null,
    blobs: new Map(),
  };
}

const store = seed();

// --- Progress stream (D4) ---

const progressHandlers = new Set<(event: VideoProgress) => void>();

export function mockSubscribeProgress(handler: (event: unknown) => void): () => void {
  const typed = handler as (event: VideoProgress) => void;
  progressHandlers.add(typed);
  return () => progressHandlers.delete(typed);
}

function emit(event: VideoProgress) {
  for (const handler of progressHandlers) handler(event);
}

/** Walks a stage from 0 to 1 so the progress UI has something real to
 * render, then resolves — see the file header on why this is inline. */
async function runStage(
  videoId: string,
  stage: VideoProgress["stage"],
  attempt: number,
  detail: string,
) {
  for (const fraction of [0, 0.25, 0.6, 0.9]) {
    emit({ video_id: videoId, stage, fraction, detail, attempt });
    await delay(180);
  }
}

// --- Helpers ---

function findProject(projectId: string): Project {
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) throw new MockNotFound("project");
  return project;
}

function findVideo(videoId: string): Video {
  const video = store.videos.find((v) => v.id === videoId);
  if (!video) throw new MockNotFound("video");
  return video;
}

function findLesson(lessonId: string): Lesson {
  const lesson = store.lessons.find((l) => l.id === lessonId);
  if (!lesson) throw new MockNotFound("lesson");
  return lesson;
}

/** Recomputes a lesson's cached `start`/`end` from its segments, and deletes
 * the lesson if it has none left — the same rule the real backend enforces. */
function resyncLesson(lessonId: string): boolean {
  const segments = store.segments.filter((s) => s.lesson_id === lessonId);
  const lesson = findLesson(lessonId);
  if (segments.length === 0) {
    store.lessons = store.lessons.filter((l) => l.id !== lessonId);
    return true;
  }
  lesson.start = Math.min(...segments.map((s) => s.start));
  lesson.end = Math.max(...segments.map((s) => s.end));
  return false;
}

function exportRow(lesson: Lesson): ExportRow {
  const video = findVideo(lesson.video_id);
  return {
    id: id("exp"),
    lesson_id: lesson.id,
    output_path: `org_demo/${video.project_id}/exports/${lesson.title.replace(/[^\w -]/g, "")}.mp4`,
    status: "queued",
    created_at: now(),
    progress: 0,
    error: null,
    lesson_title: lesson.title,
    lesson_start: lesson.start,
    lesson_end: lesson.end,
    video_file_path: video.file_path,
  };
}

// --- Router ---

type Params = Record<string, string>;
type Handler = (params: Params, body: Record<string, unknown>) => unknown | Promise<unknown>;

const routes: Array<[string, string, Handler]> = [
  // Projects
  ["POST", "/projects", (_p, body) => {
    const project: Project = {
      id: id("prj"),
      name: String(body.name ?? "Untitled"),
      created_at: now(),
      updated_at: now(),
    };
    store.projects.unshift(project);
    return project;
  }],
  ["GET", "/projects", () => store.projects],
  ["GET", "/projects/:id", (p) => findProject(p.id)],
  ["DELETE", "/projects/:id", (p) => {
    findProject(p.id);
    const videoIds = store.videos.filter((v) => v.project_id === p.id).map((v) => v.id);
    const lessonIds = store.lessons.filter((l) => videoIds.includes(l.video_id)).map((l) => l.id);
    store.segments = store.segments.filter((s) => !lessonIds.includes(s.lesson_id));
    store.lessons = store.lessons.filter((l) => !lessonIds.includes(l.id));
    store.transcript = store.transcript.filter((t) => !videoIds.includes(t.video_id));
    store.videos = store.videos.filter((v) => v.project_id !== p.id);
    store.projects = store.projects.filter((x) => x.id !== p.id);
    return undefined;
  }],

  // Upload + videos
  ["POST", "/projects/:id/uploads", (p, body) => {
    const project = findProject(p.id);
    const videoId = id("vid");
    const storageKey = `org_demo/${project.id}/${videoId}/${String(body.filename)}`;
    store.videos.push({
      id: videoId,
      project_id: project.id,
      file_path: storageKey,
      duration: null,
      transcript_status: "pending",
      created_at: now(),
      updated_at: now(),
      audio_path: null,
    });

    // The real API picks single vs. multipart from the file's size, and the
    // client branches on which it is told — so the mock has to make that
    // choice too, or the multipart path is never exercised outside CI.
    const size = Number(body.size ?? 0);
    const url = `mock://upload/${encodeURIComponent(storageKey)}`;
    if (size <= MOCK_PART_SIZE) {
      return { video_id: videoId, storage_key: storageKey, upload: { mode: "single", url } };
    }
    return {
      video_id: videoId,
      storage_key: storageKey,
      upload: {
        mode: "multipart",
        upload_id: id("mpu"),
        part_size: MOCK_PART_SIZE,
        part_count: Math.ceil(size / MOCK_PART_SIZE),
      },
    };
  }],
  ["POST", "/videos/:id/upload/part-urls", (p, body) => {
    const video = findVideo(p.id);
    const numbers = (body.part_numbers ?? []) as number[];
    return {
      urls: numbers.map((part_number) => ({
        part_number,
        url: `mock://part/${encodeURIComponent(video.file_path)}/${part_number}`,
      })),
    };
  }],
  ["POST", "/videos/:id/upload/abort", (p) => {
    const video = findVideo(p.id);
    mockParts.delete(video.file_path);
    return undefined;
  }],
  ["POST", "/videos/:id/complete", (p) => {
    const video = findVideo(p.id);
    // Reassemble the parts into the single blob playback reads, so a
    // multipart upload behaves like a single one from here on.
    const parts = mockParts.get(video.file_path);
    if (parts) {
      const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, blob]) => blob);
      store.blobs.set(video.file_path, URL.createObjectURL(new Blob(ordered)));
      mockParts.delete(video.file_path);
    }
    return video;
  }],
  ["GET", "/projects/:id/videos", (p) => store.videos.filter((v) => v.project_id === p.id)],
  ["GET", "/videos/:id", (p) => findVideo(p.id)],
  ["POST", "/videos/:id/error", (p) => {
    findVideo(p.id).transcript_status = "error";
    return undefined;
  }],
  ["DELETE", "/videos/:id", (p) => {
    findVideo(p.id);
    const lessonIds = store.lessons.filter((l) => l.video_id === p.id).map((l) => l.id);
    store.segments = store.segments.filter((s) => !lessonIds.includes(s.lesson_id));
    store.lessons = store.lessons.filter((l) => l.video_id !== p.id);
    store.transcript = store.transcript.filter((t) => t.video_id !== p.id);
    store.videos = store.videos.filter((v) => v.id !== p.id);
    return undefined;
  }],
  ["POST", "/videos/playback-url", (_p, body) => {
    const key = String(body.storage_key);
    // Only a key we minted resolves, mirroring the real endpoint's rule that
    // it looks the key up rather than signing whatever it is handed.
    return { url: store.blobs.get(key) ?? "" };
  }],

  // Pipeline
  ["POST", "/videos/:id/extract", async (p, body) => {
    const video = findVideo(p.id);
    await runStage(video.id, "ExtractingAudio", Number(body.attempt ?? 1), "Extracting audio");
    video.audio_path = `${video.file_path}.wav`;
    video.duration = video.duration ?? 1800;
    video.transcript_status = "audio_ready";
    return video;
  }],
  ["POST", "/videos/:id/transcribe", async (p, body) => {
    const video = findVideo(p.id);
    await runStage(video.id, "Transcribing", Number(body.attempt ?? 1), "Transcribing audio");
    if (!store.transcript.some((t) => t.video_id === video.id)) {
      for (let i = 0; i < 20; i++) {
        store.transcript.push({
          id: id("seg"),
          video_id: video.id,
          start: i * 60,
          end: (i + 1) * 60,
          text: `Mock transcript line ${i + 1}. Replace me with a real API (M3).`,
          keep: true,
        });
      }
    }
    video.transcript_status = "done";
    return video;
  }],
  ["POST", "/videos/:id/analyze", async (p, body) => {
    const video = findVideo(p.id);
    await runStage(video.id, "Analyzing", Number(body.attempt ?? 1), "Finding lesson boundaries");
    // Re-analysis is a clean replace of AI rows only — manual lessons survive.
    const replaced = store.lessons.filter((l) => l.video_id === video.id && l.source === "ai");
    const replacedIds = replaced.map((l) => l.id);
    store.segments = store.segments.filter((s) => !replacedIds.includes(s.lesson_id));
    store.lessons = store.lessons.filter((l) => !replacedIds.includes(l.id));
    const total = video.duration ?? 1800;
    const created: Lesson[] = [0, 1, 2].map((i) => ({
      id: id("les"),
      video_id: video.id,
      title: `Suggested lesson ${i + 1}`,
      summary: "Generated by the mock backend.",
      start: (total / 3) * i,
      end: (total / 3) * (i + 1),
      sort_order: i,
      confidence: [0.93, 0.68, 0.41][i],
      kind: i === 2 ? "qna" : "lesson",
      source: "ai",
    }));
    store.lessons.push(...created);
    for (const lesson of created) {
      store.segments.push({
        id: id("lsg"),
        lesson_id: lesson.id,
        start: lesson.start,
        end: lesson.end,
        sort_order: 0,
      });
    }
    return store.lessons.filter((l) => l.video_id === video.id);
  }],

  // Transcript
  ["GET", "/videos/:id/transcript", (p) => store.transcript.filter((t) => t.video_id === p.id)],
  ["PATCH", "/transcript-segments/:id", (p, body) => {
    const segment = store.transcript.find((t) => t.id === p.id);
    if (!segment) throw new MockNotFound("transcript segment");
    segment.keep = Boolean(body.keep);
    return segment;
  }],

  // Lessons — `/lessons/merge` must precede `/lessons/:id`
  ["POST", "/lessons/merge", (_p, body) => {
    const first = findLesson(String(body.first_id));
    const second = findLesson(String(body.second_id));
    for (const segment of store.segments.filter((s) => s.lesson_id === second.id)) {
      segment.lesson_id = first.id;
    }
    store.lessons = store.lessons.filter((l) => l.id !== second.id);
    resyncLesson(first.id);
    return first;
  }],
  ["GET", "/videos/:id/lessons", (p) => store.lessons.filter((l) => l.video_id === p.id)],
  ["POST", "/videos/:id/lessons", (p, body) => {
    const video = findVideo(p.id);
    const ranges = (body.segments ?? []) as LessonSegmentRange[];
    const lesson: Lesson = {
      id: id("les"),
      video_id: video.id,
      title: String(body.title ?? "Untitled lesson"),
      summary: null,
      start: Math.min(...ranges.map((r) => r.start)),
      end: Math.max(...ranges.map((r) => r.end)),
      sort_order: store.lessons.filter((l) => l.video_id === video.id).length,
      confidence: null,
      kind: "lesson",
      source: "manual",
    };
    store.lessons.push(lesson);
    ranges.forEach((range, index) => {
      store.segments.push({
        id: id("lsg"),
        lesson_id: lesson.id,
        start: range.start,
        end: range.end,
        sort_order: index,
      });
    });
    return lesson;
  }],
  ["PATCH", "/lessons/:id", (p, body) => {
    const lesson = findLesson(p.id);
    if (body.title != null) lesson.title = String(body.title);
    if (body.summary != null) lesson.summary = String(body.summary);
    return lesson;
  }],
  ["POST", "/lessons/:id/split", (p, body) => {
    const lesson = findLesson(p.id);
    const segment = store.segments.find((s) => s.id === String(body.segment_id));
    if (!segment) throw new MockNotFound("lesson segment");
    const at = Number(body.at_time);
    const tail: Lesson = {
      ...lesson,
      id: id("les"),
      title: `${lesson.title} (part 2)`,
      sort_order: lesson.sort_order + 1,
    };
    store.lessons.push(tail);
    store.segments.push({
      id: id("lsg"),
      lesson_id: tail.id,
      start: at,
      end: segment.end,
      sort_order: 0,
    });
    segment.end = at;
    resyncLesson(lesson.id);
    resyncLesson(tail.id);
    return [lesson, tail];
  }],
  ["DELETE", "/lessons/:id", (p) => {
    findLesson(p.id);
    store.segments = store.segments.filter((s) => s.lesson_id !== p.id);
    store.lessons = store.lessons.filter((l) => l.id !== p.id);
    return undefined;
  }],
  ["PUT", "/videos/:id/lesson-order", (p, body) => {
    const ordered = (body.ordered_ids ?? []) as string[];
    ordered.forEach((lessonId, index) => {
      const lesson = store.lessons.find((l) => l.id === lessonId && l.video_id === p.id);
      if (lesson) lesson.sort_order = index;
    });
    return undefined;
  }],

  // Lesson segments
  ["GET", "/lessons/:id/segments", (p) =>
    store.segments
      .filter((s) => s.lesson_id === p.id)
      .sort((a, b) => a.sort_order - b.sort_order)],
  ["POST", "/lessons/:id/segments", (p, body) => {
    findLesson(p.id);
    const segment: LessonSegment = {
      id: id("lsg"),
      lesson_id: p.id,
      start: Number(body.start),
      end: Number(body.end),
      sort_order: store.segments.filter((s) => s.lesson_id === p.id).length,
    };
    store.segments.push(segment);
    resyncLesson(p.id);
    return segment;
  }],
  ["PATCH", "/lesson-segments/:id", (p, body) => {
    const segment = store.segments.find((s) => s.id === p.id);
    if (!segment) throw new MockNotFound("lesson segment");
    segment.start = Number(body.start);
    segment.end = Number(body.end);
    resyncLesson(segment.lesson_id);
    return segment;
  }],
  ["DELETE", "/lesson-segments/:id", (p) => {
    const segment = store.segments.find((s) => s.id === p.id);
    if (!segment) throw new MockNotFound("lesson segment");
    const lessonId = segment.lesson_id;
    store.segments = store.segments.filter((s) => s.id !== p.id);
    const result: DeleteLessonSegmentResult = {
      lesson_id: lessonId,
      lesson_deleted: resyncLesson(lessonId),
    };
    return result;
  }],
  ["PUT", "/lessons/:id/segment-order", (p, body) => {
    const ordered = (body.ordered_ids ?? []) as string[];
    ordered.forEach((segmentId, index) => {
      const segment = store.segments.find((s) => s.id === segmentId && s.lesson_id === p.id);
      if (segment) segment.sort_order = index;
    });
    return undefined;
  }],
  ["POST", "/lessons/:id/segment-edit/preview", async (p, body) => {
    findLesson(p.id);
    await delay(600);
    const baseline =
      (body.baseline as LessonSegmentRange[] | null) ??
      store.segments
        .filter((s) => s.lesson_id === p.id)
        .map((s) => ({ start: s.start, end: s.end }));
    // Trims 5s off each end so the review popup has a visible difference.
    return baseline.map((range) => ({
      start: range.start + 5,
      end: Math.max(range.start + 6, range.end - 5),
    }));
  }],
  ["POST", "/lessons/:id/segment-edit/apply", (p, body) => {
    findLesson(p.id);
    const ranges = (body.segments ?? []) as LessonSegmentRange[];
    if (ranges.length === 0) throw new Error("An edit must leave at least one segment.");
    store.segments = store.segments.filter((s) => s.lesson_id !== p.id);
    ranges.forEach((range, index) => {
      store.segments.push({
        id: id("lsg"),
        lesson_id: p.id,
        start: range.start,
        end: range.end,
        sort_order: index,
      });
    });
    resyncLesson(p.id);
    return store.segments.filter((s) => s.lesson_id === p.id);
  }],

  // Settings — no `/settings/openai-key` routes. The key is platform-owned
  // and lives in the API's environment (D7), so the browser never sees one
  // and there is nothing here to mock.
  ["PUT", "/settings/analysis-instructions", (_p, body) => {
    store.analysisInstructions = String(body.instructions);
    return undefined;
  }],
  ["GET", "/settings/analysis-instructions", () => ({
    instructions: store.analysisInstructions,
  })],

  // Exports
  ["POST", "/exports", (_p, body) => {
    const rows = (body.lesson_ids as string[]).map((lessonId) => exportRow(findLesson(lessonId)));
    store.exports.unshift(...rows);
    // Walk each row to `done` so Export History has something to show.
    for (const row of rows) {
      void (async () => {
        await delay(500);
        row.status = "running";
        for (const progress of [0.3, 0.7, 1]) {
          await delay(400);
          row.progress = progress;
        }
        row.status = "done";
      })();
    }
    return rows;
  }],
  ["POST", "/exports/:id/pause", (p) => setExportStatus(p.id, "paused")],
  ["POST", "/exports/:id/resume", (p) => setExportStatus(p.id, "queued")],
  ["POST", "/exports/:id/cancel", (p) => setExportStatus(p.id, "cancelled")],
  ["POST", "/exports/:id/retry", (p) => setExportStatus(p.id, "queued")],
  ["GET", "/projects/:id/exports", (p) => {
    const videoIds = store.videos.filter((v) => v.project_id === p.id).map((v) => v.id);
    const lessonIds = store.lessons.filter((l) => videoIds.includes(l.video_id)).map((l) => l.id);
    return store.exports.filter((e) => lessonIds.includes(e.lesson_id));
  }],
  ["POST", "/exports/download-url", () => ({ url: "" })],
];

function setExportStatus(exportId: string, status: string): ExportRow {
  const row = store.exports.find((e) => e.id === exportId);
  if (!row) throw new MockNotFound("export");
  if (row.status === "running" && (status === "paused" || status === "queued")) {
    throw new Error("This export is already encoding — cancel it instead.");
  }
  row.status = status;
  if (status === "queued") {
    row.progress = 0;
    row.error = null;
  }
  return row;
}

function match(pattern: string, path: string): Params | null {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: Params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (expected !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export async function mockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  // A little latency everywhere, so loading states are exercised rather than
  // skipped past — the desktop app's IPC is fast but not instant either.
  await delay(80);
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const params = match(pattern, path);
    if (!params) continue;
    return (await handler(params, (body ?? {}) as Record<string, unknown>)) as T;
  }
  throw new Error(`No mock route for ${method} ${path}`);
}

export async function mockPutToStorage(url: string, file: Blob): Promise<void> {
  await delay(300);
  const key = decodeURIComponent(url.replace("mock://upload/", ""));
  // Keeping the object URL is what makes uploaded video actually play back
  // in mock mode; a real upload obviously keeps nothing client-side.
  store.blobs.set(key, URL.createObjectURL(file));
}

/** Parts held between `putPart` and `/complete`, keyed by storage key. */
const mockParts = new Map<string, Map<number, Blob>>();

export async function mockPutPart(url: string, part: Blob): Promise<string> {
  await delay(120);
  const [, rest] = url.split("mock://part/");
  const separator = rest.lastIndexOf("/");
  const key = decodeURIComponent(rest.slice(0, separator));
  const partNumber = Number(rest.slice(separator + 1));

  let parts = mockParts.get(key);
  if (!parts) {
    parts = new Map();
    mockParts.set(key, parts);
  }
  parts.set(partNumber, part);
  // The real ETag is storage's checksum of the part; nothing on the client
  // inspects it beyond passing it back, so a stable stand-in is enough.
  return `"mock-etag-${partNumber}"`;
}
