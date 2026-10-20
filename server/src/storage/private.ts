// server/src/storage/private.ts — milestone 26.
//
// WHERE IDENTITY DOCUMENTS LIVE, which is deliberately not where product photos live.
//
//   storage/images.ts   public. Names are random, bytes are served to anyone who has the URL, because a storefront <img>
//                       carries no session. Fine for a photo of a burger.
//   storage/private.ts  nothing here is ever served by URL. An object is reachable only through a function that is
//                       handed its key by a route that has already decided who may see it, and the bytes on disk are
//                       SEALED (crypto/kyc.ts) so the directory is useless without the key.
//
// THE SAME SEAM AS IMAGES, for the same reason: a PrivateStore is `put / read / delete`, rows keep an opaque key, and
// moving to S3/R2 with server-side encryption is a second driver and a copy rather than a migration. The local driver is
// for development and tests. It is NOT fit to be production's only copy — one disk, no replication — and which store
// production uses is still an open decision (Part 9).

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, seal } from '../crypto/kyc.ts';
import { ensureBucket, minioClient } from './minio.ts';

export interface PrivateStore {
  /** Seals and stores. Returns the opaque key to keep in a row and the name of the key that sealed it. */
  put(bytes: Uint8Array): Promise<{ key: string; keyId: string }>;
  /** Opens. Null when the object is gone — purged, or never there. */
  read(key: string, keyId: string): Promise<Buffer | null>;
  /** Idempotent: deleting what is already gone is not an error, because the purge may be retried. */
  delete(key: string): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

/** 32 hex characters: unguessable and, more to the point, nothing a caller can use to walk the directory. */
export const PRIVATE_KEY = /^[0-9a-f]{32}\.bin$/;

export function localPrivateStore(root = process.env['PRIVATE_DIR'] ?? resolve(here, '../../.private')): PrivateStore {
  const pathOf = (key: string): string => {
    if (!PRIVATE_KEY.test(key)) throw new Error('not a private-store key');
    return join(root, key.slice(0, 2), key);
  };
  return {
    async put(bytes) {
      const key = `${randomUUID().replaceAll('-', '')}.bin`;
      const sealed = seal(bytes);
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, sealed.bytes, { mode: 0o600 });
      return { key, keyId: sealed.keyId };
    },
    async read(key, keyId) {
      try {
        return open(await readFile(pathOf(key)), keyId);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw cause;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

export const PRIVATE_BUCKET = process.env['MINIO_PRIVATE_BUCKET'] ?? 'vendlyfy-private';

/** Production driver, decided 2026-10-20. Bytes are sealed here, same as the local driver — MinIO never sees
 * plaintext, so which store holds the object changes nothing about what crypto/kyc.ts guarantees. No sharding
 * subdirectory (the local driver's 2-char prefix exists only to keep one filesystem directory from holding too
 * many entries; a bucket has no such limit). */
export function minioPrivateStore(bucket = PRIVATE_BUCKET): PrivateStore {
  return {
    async put(bytes) {
      await ensureBucket(bucket);
      const key = `${randomUUID().replaceAll('-', '')}.bin`;
      const sealed = seal(bytes);
      await minioClient().putObject(bucket, key, Buffer.from(sealed.bytes));
      return { key, keyId: sealed.keyId };
    },
    async read(key, keyId) {
      if (!PRIVATE_KEY.test(key)) throw new Error('not a private-store key');
      try {
        const stream = await minioClient().getObject(bucket, key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return open(Buffer.concat(chunks), keyId);
      } catch (cause) {
        if ((cause as { code?: string }).code === 'NoSuchKey' || (cause as { code?: string }).code === 'NotFound') return null;
        throw cause;
      }
    },
    async delete(key) {
      if (!PRIVATE_KEY.test(key)) throw new Error('not a private-store key');
      await minioClient().removeObject(bucket, key);
    },
  };
}

let current: PrivateStore | null = null;

/** PRIVATE_STORE=minio switches it; anything else (including unset) is local. Independent of MEDIA_STORE on
 * purpose — the two stores' production-readiness decisions were never coupled (see the header above). */
export function privateStore(): PrivateStore {
  if (current === null) current = (process.env['PRIVATE_STORE'] ?? 'local').trim().toLowerCase() === 'minio' ? minioPrivateStore() : localPrivateStore();
  return current;
}

/** The tests' seam, as setImageStore is. */
export function setPrivateStore(next: PrivateStore | null): void {
  current = next;
}
