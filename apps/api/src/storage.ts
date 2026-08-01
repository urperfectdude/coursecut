// The only file in this repo that talks S3.
//
// Plan §3.4's portability rules are the reason it exists, and they are review
// gates rather than aspirations:
//
//   1. **Store keys, never URLs.** `videos.storage_key` and
//      `exports.output_key` hold `{org}/{project}/{video}/…`. A bucket
//      hostname in the database bakes the vendor into the data.
//   2. **One storage module.** Never construct an `S3Client` in a route
//      handler. `apps/worker` (M5) imports this same file.
//   3. **Bucket hostnames never reach the frontend.** The SPA only ever
//      receives server-minted presigned URLs, so it is never coupled to a
//      provider — and never holds a credential either.
//
// MinIO locally, Cloudflare R2 in production. Both speak S3, so the only
// difference is the endpoint, the credentials, and path-style addressing
// (MinIO needs it, R2 does not) — all of it in `env.ts`. There is no
// provider-conditional code below, and there should never be.
//
// Video bytes never pass through this process: every transfer is the browser
// or the worker talking to storage directly with a presigned URL (plan §3.2).
// Nothing here streams a body.

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
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  type CORSRule,
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

/**
 * S3 keys are opaque, but a filename that arrived from a browser is not
 * trustworthy: `../` in it would escape the org prefix that makes an
 * object-store listing tenant-scoped, which is half of plan §6's isolation
 * story. Path separators and control characters go; everything else is kept
 * so the key still ends with something the user recognises (`db.ts` relies on
 * that — `basename(video.file_path)` is what the UI renders).
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

/** `{org}/{project}/{video}/{filename}` — plan §3.4 rule 1. */
export function videoKey(
  orgId: string,
  projectId: string,
  videoId: string,
  filename: string,
): string {
  return `${orgId}/${projectId}/${videoId}/${sanitizeFilename(filename)}`;
}

/**
 * Where a video's extracted audio lands: beside the video it belongs to, not
 * in a shared cache.
 *
 * Desktop keys its WAV cache by content hash in one app-wide directory, and
 * deliberately never deletes from it because another video may share the file.
 * That is exactly what cannot be copied here — a shared object would outlive
 * the delete that plan §9 promises purges a video. So each video owns its
 * audio under its own prefix, and the cache is preserved a different way: a
 * second upload of the same bytes gets the object **copied** to its own prefix
 * (server-side, no re-download and no ffmpeg) rather than pointed at someone
 * else's. See the worker's extract task.
 */
export function audioKey(orgId: string, projectId: string, videoId: string, ext = "ogg"): string {
  return `${orgId}/${projectId}/${videoId}/audio.${ext}`;
}

/** The extension an existing audio key was stored under. The worker needs it
 * in two places: naming the copy it makes of a sibling's cached audio (a
 * `.wav` object must not land under a `.ogg` key), and telling Whisper what
 * it is being sent. Objects written before extraction moved to Opus are still
 * `.wav`, and stay readable — the column holds the real key, so nothing
 * recomputes a stale one. */
export function audioKeyExt(key: string): string {
  const ext = key.split("/").pop()?.split(".").pop();
  return ext && ext !== key ? ext : "ogg";
}

/** Where the worker's finished MP4 lands (D5). Same org-first prefix. */
export function exportKey(orgId: string, projectId: string, exportId: string, filename: string): string {
  return `${orgId}/${projectId}/exports/${exportId}/${sanitizeFilename(filename)}`;
}

/** Everything under one project, for the purge a project delete owes (§9). */
export function projectPrefix(orgId: string, projectId: string): string {
  return `${orgId}/${projectId}/`;
}

/** Everything belonging to one video — its source and its extracted audio. */
export function videoPrefix(orgId: string, projectId: string, videoId: string): string {
  return `${orgId}/${projectId}/${videoId}/`;
}

// ---------------------------------------------------------------------------
// Presigned URLs
// ---------------------------------------------------------------------------

function ttl(): number {
  return env.s3UrlTtlSeconds();
}

/** Short-TTL GET, for playback (D2) and export downloads (D6). */
export function presignGet(key: string, options?: { downloadAs?: string }): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      // Set only for a download: playback must stay inline or the browser
      // saves the video instead of playing it.
      ResponseContentDisposition: options?.downloadAs
        ? `attachment; filename="${sanitizeFilename(options.downloadAs)}"`
        : undefined,
    }),
    { expiresIn: ttl() },
  );
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
// M3's "done when" is a multi-GB file uploading from the browser in parts, and
// parts are not an optimization here: S3 caps a single PUT at 5 GiB (R2 lower
// in practice), and a one-shot PUT of a lecture recording has to start over
// from zero on any network blip. With parts, a retry costs one part.
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
 * count is 10,000; 64 MiB puts a 2 GB lecture at ~32 parts and keeps a
 * hypothetical 640 GB file inside the limit, while still being small enough
 * that a failed part is a cheap retry.
 */
export const PART_SIZE = 64 * 1024 * 1024;

/**
 * Above this, upload in parts. Below it, one PUT is simpler and saves three
 * round trips — and a lecture clip small enough to land here re-uploads in
 * seconds if it fails.
 */
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
// signed. The ones below are this side of the house: `apps/worker` has real
// credentials and moves whole files, because ffmpeg needs a seekable local
// file and Whisper needs the audio bytes.
//
// This is still "video bytes never pass through the API": the worker is a
// different process (plan §3.2), and on R2 its downloads are free at both ends
// (§3.4). The module comment's promise is about the request path, which is
// unchanged — nothing here is reachable from a route handler.

/**
 * Streams an object to a local path, hashing it on the way past.
 *
 * The hash is SHA-256 of the source bytes — desktop's `content_hash`, the key
 * to the transcript cache (PRD §7.4). Computing it during the download the job
 * has to do anyway means a multi-gigabyte lecture is read once, not twice.
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
  // this. In the pipeline there is nothing to reason about — every byte
  // written is a byte hashed.
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
 * `Upload` streams rather than buffering, which matters: an exported lesson is
 * an MP4 the worker just wrote to scratch, and reading it into memory to PUT
 * it would put a lecture-sized allocation in a process that is already running
 * ffmpeg.
 */
export async function uploadFile(
  key: string,
  source: string,
  contentType: string,
): Promise<void> {
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

/** Reads a whole object into memory. Only used for extracted audio on its way
 * to Whisper, which is bounded by the recording's length at 32 KB/s. */
export async function getObjectBytes(key: string): Promise<Uint8Array<ArrayBuffer>> {
  const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = result.Body as Readable | undefined;
  if (!body) throw new Error(`storage returned no body for ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Server-side copy — no bytes cross this process.
 *
 * What makes the audio cache work without sharing an object between two rows:
 * a re-uploaded video adopts a copy of the already-extracted WAV under its own
 * prefix, so deleting either video purges only its own.
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

/** Removes one object — a cancelled export's partial output, say. */
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

/**
 * Everything under a prefix, paginated through to the end.
 *
 * Only the retention sweep (M7) uses it, and it needs `lastModified` rather
 * than just the key: an object younger than the sweep's grace period is not an
 * orphan even when no row claims it — it is an upload whose row has not
 * committed yet. A listing without timestamps could not tell those apart.
 */
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
        objects.push({
          key: object.Key,
          size: object.Size ?? 0,
          lastModified: object.LastModified,
        });
      }
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

/**
 * Deletes everything under a prefix. Plan §9 promises a deleted project has
 * its objects purged, and a row delete alone would leave the video sitting in
 * a bucket we told the user it had left.
 *
 * Best-effort by design: the caller deletes the rows in a transaction and
 * calls this after committing. A failure here leaves orphaned objects, which
 * M7's retention sweep is the backstop for — the alternative, refusing the
 * row delete because a bucket call failed, is worse.
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

// ---------------------------------------------------------------------------
// Bucket CORS (M6)
// ---------------------------------------------------------------------------
//
// The browser talks to storage directly (plan §3.2), so the bucket — not this
// API — decides whether an upload is allowed to happen at all. Without a CORS
// rule every upload fails in the browser while working perfectly from `curl`,
// which is a confusing enough failure to be worth configuring from code that
// can be re-run and read back.
//
// Locally this is MinIO's `MINIO_API_CORS_ALLOW_ORIGIN` (server-wide, set in
// `infra/postgres/compose.yml`, because MinIO does not implement
// `PutBucketCors`). In production it is the per-bucket policy below. That is
// the one deployment difference between the two — no code branches on it.

/**
 * The rule the shipped client actually needs, and nothing more.
 *
 *   PUT   the upload, single-shot and per-part
 *   GET   playback and export downloads
 *   HEAD  what a range request preflights to during scrubbing
 *
 * `ETag` is exposed because a cross-origin response only surfaces headers the
 * server names, and `putPart` in `apps/web/src/api/http.ts` cannot complete a
 * multipart upload without reading each part's ETag. `content-type` is allowed
 * because `putToStorage` sends it, and a header the signature covered but CORS
 * did not is a rejected preflight.
 *
 * No `DELETE`: aborting an abandoned multipart upload is a server-side call
 * with real credentials, not something the browser is trusted to do.
 */
export function browserCorsRule(origins: string[]): CORSRule {
  return {
    AllowedOrigins: origins,
    AllowedMethods: ["GET", "PUT", "HEAD"],
    AllowedHeaders: ["content-type"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  };
}

/**
 * Applies `browserCorsRule` to the configured bucket, replacing whatever was
 * there — S3's PutBucketCors is a whole-configuration write, not a merge.
 *
 * Origins are named explicitly rather than left at `*` for the same reason
 * MinIO's is: a presigned URL is a bearer credential for one object, and there
 * is no reason for a page on another origin to be able to spend one.
 */
export async function applyBucketCors(origins: string[]): Promise<void> {
  await s3().send(
    new PutBucketCorsCommand({
      Bucket: bucket(),
      CORSConfiguration: { CORSRules: [browserCorsRule(origins)] },
    }),
  );
}

/** Reads the bucket's CORS configuration back, or `null` if it has none. */
export async function getBucketCors(): Promise<CORSRule[] | null> {
  try {
    const result = await s3().send(new GetBucketCorsCommand({ Bucket: bucket() }));
    return result.CORSRules ?? [];
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchCORSConfiguration" || isNotFound(err)) return null;
    throw err;
  }
}
