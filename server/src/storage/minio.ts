// server/src/storage/minio.ts — the client both storage seams share when a MINIO_ driver is chosen (decided
// 2026-10-20: MinIO for production image/file storage, both the public media store and the private KYC/evidence
// store — see storage/images.ts and storage/private.ts for why those stay two separate buckets with different
// access rules rather than one).
//
// One client per process, lazily created on first use so a server that never asks for the minio driver (MEDIA_STORE
// and PRIVATE_STORE both unset/local, e.g. every test run) never needs MINIO_* configured at all.

import { Client } from 'minio';

let client: Client | null = null;

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') throw new Error(`${name} is not set; a MINIO-backed store needs it`);
  return v;
}

export function minioClient(): Client {
  client ??= new Client({
    endPoint: required('MINIO_ENDPOINT'),
    port: process.env['MINIO_PORT'] === undefined ? undefined : Number(process.env['MINIO_PORT']),
    useSSL: (process.env['MINIO_USE_SSL'] ?? 'false').trim().toLowerCase() === 'true',
    accessKey: required('MINIO_ACCESS_KEY'),
    secretKey: required('MINIO_SECRET_KEY'),
  });
  return client;
}

const ensured = new Set<string>();

/** Creates the bucket if it does not exist yet. Safe to call on every put(): checked once per bucket per process. */
export async function ensureBucket(bucket: string): Promise<void> {
  if (ensured.has(bucket)) return;
  const c = minioClient();
  if (!(await c.bucketExists(bucket))) await c.makeBucket(bucket);
  ensured.add(bucket);
}

/** Test seam: forget the cached client and which buckets were confirmed, so a test can point at a fresh fixture. */
export function resetMinioClient(): void {
  client = null;
  ensured.clear();
}
