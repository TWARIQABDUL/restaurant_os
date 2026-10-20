// server/src/storage/images.ts — milestone 22.
//
// WHERE A PRODUCT PHOTO LIVES. The plan (§4.2) left this open — "keep the existing Supabase bucket behind signed
// URLs, or move to S3/R2. Locally, stub the upload endpoint" — and it is still the user's decision, because
// the same store will hold KYC documents and complaint evidence (one of which is biometric). So this file is the
// SEAM, not the answer: everything outside it knows only `ImageStore`, and a row stores a path this layer
// resolves (`/api/media/<store>/<name>`), never a vendor URL. Moving to a bucket is a second implementation of
// this interface and a one-off copy; no migration rewrites any row.
//
// WHAT THE LOCAL DRIVER IS FOR: development and tests, and nothing else. It writes under MEDIA_DIR (default
// server/.media, git-ignored). It is NOT fit to be production's only copy: a container's disk goes with the
// container. Which is the second reason the decision is flagged rather than made.
//
// WHAT IS CHECKED, because an upload endpoint is an unauthenticated-looking surface even when it is guarded:
//   * the BYTES, not the Content-Type header — a file is accepted when it begins with a JPEG, PNG or WebP
//     signature, so a renamed HTML file is not an image whatever the client called it. The same raster-only
//     allowlist the legacy bucket got at SEC-01 ("a leaked signed upload URL cannot park an HTML or SVG file
//     that would execute on the storage origin"). SVG is deliberately absent for that reason.
//   * the SIZE, 5 MB, the legacy bucket's own limit.
//   * the NAME is generated here — 16 random bytes — so a client chooses neither the path nor the extension.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBucket, minioClient } from './minio.ts';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageKind = 'jpg' | 'png' | 'webp';

export const CONTENT_TYPE: Record<ImageKind, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** What the bytes say they are, or null. Reads the signature, never the header the client sent. */
export function sniff(bytes: Uint8Array): ImageKind | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return 'png';
  }
  // RIFF....WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

export interface ImageStore {
  /** Stores the bytes under a generated name and returns the path a row should keep. */
  put(storeId: string, bytes: Buffer, kind: ImageKind): Promise<string>;
  /** The bytes for a name previously returned by put(), or null. */
  read(storeId: string, name: string): Promise<{ bytes: Buffer; kind: ImageKind } | null>;
}

export const MEDIA_PATH = '/api/media';

/** Exactly what put() generates. Anything else is not a name this store ever issued. */
export const IMAGE_NAME = /^[0-9a-f]{32}\.(jpg|png|webp)$/;

const here = dirname(fileURLToPath(import.meta.url));

export function localImageStore(root = process.env['MEDIA_DIR'] ?? resolve(here, '../../.media')): ImageStore {
  return {
    async put(storeId, bytes, kind) {
      const name = `${randomBytes(16).toString('hex')}.${kind}`;
      const dir = join(root, storeId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), bytes, { flag: 'wx' });
      return `${MEDIA_PATH}/${storeId}/${name}`;
    },
    async read(storeId, name) {
      // The regex is what keeps this inside `root`: no separator, no dot-dot, nothing but hex and an extension.
      const m = IMAGE_NAME.exec(name);
      if (m === null) return null;
      try {
        const bytes = await readFile(join(root, storeId, name));
        return { bytes, kind: m[1] as ImageKind };
      } catch {
        return null;
      }
    },
  };
}

export const MEDIA_BUCKET = process.env['MINIO_MEDIA_BUCKET'] ?? 'vendlyfy-media';

/** Production driver, decided 2026-10-20. The object key is the same `<storeId>/<name>` shape put() has always
 * returned in the URL — only where the bytes physically live changes; mediaRouter's read-and-stream behaviour
 * (storeUploads.ts) does not, so this is a drop-in swap behind the same ImageStore seam. */
export function minioImageStore(bucket = MEDIA_BUCKET): ImageStore {
  return {
    async put(storeId, bytes, kind) {
      await ensureBucket(bucket);
      const name = `${randomBytes(16).toString('hex')}.${kind}`;
      const key = `${storeId}/${name}`;
      await minioClient().putObject(bucket, key, bytes, bytes.length, { 'Content-Type': CONTENT_TYPE[kind] });
      return `${MEDIA_PATH}/${storeId}/${name}`;
    },
    async read(storeId, name) {
      const m = IMAGE_NAME.exec(name);
      if (m === null) return null;
      try {
        const stream = await minioClient().getObject(bucket, `${storeId}/${name}`);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return { bytes: Buffer.concat(chunks), kind: m[1] as ImageKind };
      } catch {
        return null;
      }
    },
  };
}

let current: ImageStore | null = null;

/** One store per process, chosen once. MEDIA_STORE=minio switches it; anything else (including unset) is local —
 * same "explicit, no auto-detect" rule the messaging transport seam uses. Tests swap it with setImageStore(). */
export function imageStore(): ImageStore {
  if (current === null) current = (process.env['MEDIA_STORE'] ?? 'local').trim().toLowerCase() === 'minio' ? minioImageStore() : localImageStore();
  return current;
}

export function setImageStore(next: ImageStore | null): void {
  current = next;
}
