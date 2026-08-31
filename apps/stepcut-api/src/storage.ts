// The only file in this package that talks S3.
//
// Own copy of apps/api/src/storage.ts's discipline, pointed at the same
// bucket under StepCut's own `stepcut/` prefix (plan §7):
//
//   1. **Store keys, never URLs.** `videos.storage_key` holds
//      `stepcut/{org}/{video}/…`. A bucket hostname in the database bakes the
//      vendor into the data.
//   2. **One storage module.** Never construct an `S3Client` outside this
//      file. `apps/stepcut-worker` imports this same file.
//   3. **Bucket hostnames never reach the frontend.** `apps/stepcut` only
//      ever receives server-minted presigned URLs.
//
// MinIO locally, Cloudflare R2 in production — the same bucket coursecut-web
// uses, disjoint only by key prefix (plan §7's "same bucket, no new
// credentials to issue or rotate"). Both speak S3, so the only difference is
// the endpoint, the credentials, and path-style addressing, all of it in
// `env.ts`.
//
// No CORS section here (unlike apps/api's copy): applying the browser CORS
// rule to the shared bucket is a deployment concern that belongs beside
// whichever product's tooling manages the bucket, not duplicated per-app —
// see `infra/postgres/compose.yml` for how local dev covers it directly.
//
// Video bytes never pass through this process: every transfer is the browser
// or the worker talking to storage directly with a presigned URL.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env.js";

let client: S3Client | undefined;

/** Lazily built, so importing this module never constructs a client. */
function s3(): S3Client {
  client ??= new S3Client({
    region: env.s3Region(),
    endpoint: env.s3Endpoint(),
    forcePathStyle: env.s3ForcePathStyle(),
    credentials: {
      accessKeyId: env.s3AccessKeyId(),
      secretAccessKey: env.s3SecretAccessKey(),
    },
  });
  return client;
}

function bucket(): string {
  return env.s3Bucket();
}

/** Every StepCut key lives under this prefix, disjoint from coursecut-web's
 * `{org}/{project}/…` keys in the same bucket (plan §7). */
const PREFIX = "stepcut";

/**
 * S3 keys are opaque, but a filename that arrived from a browser is not
 * trustworthy: `../` in it would escape the org prefix that makes an
 * object-store listing tenant-scoped. Path separators and control characters
 * go; everything else is kept so the key still ends with something the user
 * recognises.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  // "." and ".." are literal names to S3 but confuse everything downstream
  // of it, so they are treated as no name at all.
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "upload";
  return cleaned.slice(0, 200);
}

/** `stepcut/{org}/{video}/{filename}` — no `project` segment (plan §3 has no
 * `projects` table in StepCut). */
export function videoKey(orgId: string, videoId: string, filename: string): string {
  return `${PREFIX}/${orgId}/${videoId}/${sanitizeFilename(filename)}`;
}

/** Where a video's extracted audio lands: beside the video it belongs to. A
 * second upload of the same bytes gets the object **copied** to its own
 * prefix (server-side, no re-download and no ffmpeg) rather than pointed at
 * someone else's — see the worker's extract task. */
export function audioKey(orgId: string, videoId: string, ext = "ogg"): string {
  return `${PREFIX}/${orgId}/${videoId}/audio.${ext}`;
}

/** The extension an existing audio key was stored under — the worker needs
 * it to name the copy it makes of a sibling's cached audio and to tell
 * Whisper what it is being sent. */
export function audioKeyExt(key: string): string {
  const ext = key.split("/").pop()?.split(".").pop();
  return ext && ext !== key ? ext : "ogg";
}

/** Everything belonging to one video — its source and its extracted audio. */
export function videoPrefix(orgId: string, videoId: string): string {
  return `${PREFIX}/${orgId}/${videoId}/`;
}

/** `stepcut/{org}/templates/{template}/{kind}/{filename}` — a template's
 * assets sit under their own `templates` segment, disjoint from a video's
 * prefix above, so `templatePrefix` below never collides with `videoPrefix`. */
export function templateAssetKey(
  orgId: string,
  templateId: string,
  kind: "intro" | "outro" | "logo",
  filename: string,
): string {
  return `${PREFIX}/${orgId}/templates/${templateId}/${kind}/${sanitizeFilename(filename)}`;
}

/** Everything belonging to one template — its intro/outro/logo assets. */
export function templatePrefix(orgId: string, templateId: string): string {
  return `${PREFIX}/${orgId}/templates/${templateId}/`;
}

/** Where a render's assembled output lands — beside the source video it was
 * cut from, under its own render id (two renders of the same video, against
 * different templates, get disjoint keys). `renders.format = 'video'` only —
 * `'markdown'`/`'html'` use the three key builders below instead. */
export function renderKey(orgId: string, videoId: string, renderId: string): string {
  return `${PREFIX}/${orgId}/${videoId}/renders/${renderId}/output.mp4`;
}

/** One step's individually-cut clip, for a `'markdown'`/`'html'` render —
 * keyed by the `render_steps` row's own id, the same id
 * `routes/exports-public.ts`'s `/steps/:stepId` route looks the row up by. */
export function renderStepAssetKey(
  orgId: string,
  videoId: string,
  renderId: string,
  stepRowId: string,
): string {
  return `${PREFIX}/${orgId}/${videoId}/renders/${renderId}/steps/${stepRowId}.mp4`;
}

/** A `'markdown'`-format render's generated `.md` — downloaded the same way
 * `renderKey`'s stitched MP4 is (a fresh presigned GET), unlike the per-step
 * clips it embeds by public URL. */
export function renderMarkdownKey(orgId: string, videoId: string, renderId: string): string {
  return `${PREFIX}/${orgId}/${videoId}/renders/${renderId}/output.md`;
}

/** A `'html'`-format render's generated page — never presigned; served
 * straight from `routes/exports-public.ts`'s public `GET /api/exports/:id`,
 * which is what makes its URL permanent. */
export function renderHtmlKey(orgId: string, videoId: string, renderId: string): string {
  return `${PREFIX}/${orgId}/${videoId}/renders/${renderId}/index.html`;
}

// ---------------------------------------------------------------------------
// Presigned URLs
// ---------------------------------------------------------------------------

function ttl(): number {
  return env.s3UrlTtlSeconds();
}

/** Short-TTL GET. Nothing in Phase 2 mints one yet (no playback route), but
 * the worker's server-side reads below use the client directly rather than a
 * signed URL, so this is here for the same reason apps/api's copy keeps it —
 * one storage module, not one per caller. */
export function presignGet(key: string): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: ttl(),
  });
}

/** Single-shot PUT, used for uploads small enough not to need parts. */
export function presignPut(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn: ttl() },
  );
}

// ---------------------------------------------------------------------------
// Multipart upload
// ---------------------------------------------------------------------------
//
// A multi-GB file uploading from the browser in parts is not an
// optimization: S3 caps a single PUT at 5 GiB (R2 lower in practice), and a
// one-shot PUT of a lecture recording has to start over from zero on any
// network blip. With parts, a retry costs one part.
//
// The flow, all of it client-driven so the API never sees a byte:
//
//   1. `createMultipartUpload` → upload id
//   2. `presignUploadPart` per part → the browser PUTs each and keeps its ETag
//   3. `completeMultipartUpload` with the (part number, ETag) list
//   4. `abortMultipartUpload` if the browser gives up, so the parts are not
//      billed forever

/**
 * 64 MiB. S3's floor for a non-final part is 5 MiB and its ceiling on part
 * count is 10,000; 64 MiB puts a 2 GB recording at ~32 parts and keeps a
 * hypothetical 640 GB file inside the limit, while still being small enough
 * that a failed part is a cheap retry.
 */
export const PART_SIZE = 64 * 1024 * 1024;

/** Above this, upload in parts. Below it, one PUT is simpler and saves three
 * round trips. */
export const MULTIPART_THRESHOLD = PART_SIZE;

export function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / PART_SIZE));
}

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const result = await s3().send(
    new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
  );
  if (!result.UploadId) throw new Error("storage did not return an upload id");
  return result.UploadId;
}

export function presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
  return getSignedUrl(
    s3(),
    new UploadPartCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: ttl() },
  );
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: UploadedPart[],
): Promise<void> {
  await s3().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        // S3 requires ascending part numbers; the browser may report them in
        // completion order, which with concurrent parts is not the same thing.
        Parts: [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    }),
  );
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  await s3().send(
    new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }),
  );
}

// ---------------------------------------------------------------------------
// Server-side transfers (the worker's half)
// ---------------------------------------------------------------------------
//
// Everything above is the browser talking to storage with a URL this process
// signed. The ones below are this side of the house: `apps/stepcut-worker`
// has real credentials and moves whole files, because ffmpeg needs a
// seekable local file and Whisper needs the audio bytes.

/**
 * Streams an object to a local path, hashing it on the way past.
 *
 * The hash is SHA-256 of the source bytes — the key to the transcript/audio
 * cache. Computing it during the download the job has to do anyway means a
 * multi-gigabyte recording is read once, not twice.
 */
export async function downloadToFile(
  key: string,
  destination: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;

  const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = result.Body as Readable | undefined;
  if (!body) throw new Error(`storage returned no body for ${key}`);

  // Hashed by a pass-through inside the pipeline rather than by a `data`
  // listener beside it: a listener puts the stream in flowing mode as soon as
  // it is attached, which is a race to reason about every time someone reads
  // this. In the pipeline every byte written is a byte hashed.
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });

  await pipeline(body, digest, createWriteStream(destination));
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * Uploads a local file, in parts when it is big enough to need them.
 *
 * `Upload` streams rather than buffering: extracted audio is bounded by the
 * recording's length, but reading a whole file into memory to PUT it is
 * still worth avoiding in a process that may also be running ffmpeg.
 */
export async function uploadFile(key: string, source: string, contentType: string): Promise<void> {
  const { size } = await stat(source);
  await new Upload({
    client: s3(),
    params: {
      Bucket: bucket(),
      Key: key,
      Body: createReadStream(source),
      ContentType: contentType,
      ContentLength: size,
    },
    partSize: PART_SIZE,
  }).done();
}

/** Reads a whole object into memory. Only used for extracted audio on its
 * way to Whisper, which is bounded by the recording's length. */
export async function getObjectBytes(key: string): Promise<Uint8Array<ArrayBuffer>> {
  const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = result.Body as Readable | undefined;
  if (!body) throw new Error(`storage returned no body for ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Opens a streaming read of one object — what `routes/exports-public.ts`
 * pipes straight into an HTTP response body, rather than buffering a
 * multi-megabyte step clip into memory the way `getObjectBytes` above does
 * for (small, bounded) audio. `null` on a missing key rather than a thrown
 * error, since the caller's only use of that is a 404, not a 500.
 */
export async function getObjectStream(
  key: string,
): Promise<{ body: Readable; contentLength?: number } | null> {
  try {
    const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    const body = result.Body as Readable | undefined;
    if (!body) return null;
    return { body, contentLength: result.ContentLength };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Server-side copy — no bytes cross this process.
 *
 * What makes the audio cache work without sharing an object between two
 * rows: a re-uploaded video adopts a copy of the already-extracted audio
 * under its own prefix, so deleting either video purges only its own.
 */
export async function copyObject(sourceKey: string, destinationKey: string): Promise<void> {
  await s3().send(
    new CopyObjectCommand({
      Bucket: bucket(),
      // The source is bucket-qualified and must be URI-encoded; the key can
      // contain characters (spaces, `+`) that would otherwise be re-read.
      CopySource: `${bucket()}/${encodeURIComponent(sourceKey).replace(/%2F/g, "/")}`,
      Key: destinationKey,
    }),
  );
}

/** Removes one object. */
export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

// ---------------------------------------------------------------------------
// Object lifecycle
// ---------------------------------------------------------------------------

/** Size in bytes, or `null` if the object is not there. */
export async function headObject(key: string): Promise<{ size: number } | null> {
  try {
    const result = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: result.ContentLength ?? 0 };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}

export interface StoredObject {
  key: string;
  size: number;
  lastModified?: Date;
}

/** Everything under a prefix, paginated through to the end. */
export async function listObjects(prefix: string): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];
  let continuationToken: string | undefined;

  do {
    const listed = await s3().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key) {
        objects.push({ key: object.Key, size: object.Size ?? 0, lastModified: object.LastModified });
      }
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/**
 * Deletes everything under a prefix — a deleted video's storage purge.
 *
 * Best-effort by design: the caller deletes the rows in a transaction and
 * calls this after committing. A failure here leaves orphaned objects; there
 * is no retention sweep yet to clean them up (that is Phase 6 territory), so
 * this is the only purge mechanism Phase 2 has.
 */
export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listed = await s3().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (listed.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));
    if (keys.length > 0) {
      await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys } }));
      deleted += keys.length;
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}
