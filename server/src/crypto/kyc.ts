// server/src/crypto/kyc.ts — milestone 26.
//
// THE KEY IS NOT IN THE DATABASE, and that sentence is the whole design. V012 stores ciphertext and the name of the key
// that made it; this file is where the key actually is — an environment variable, for now (the decision recorded for this
// milestone: ".env for now"). A stolen backup, a leaked dump or a curious query therefore gets bytes nobody can read,
// while the application — which is the only thing holding the key — can still open them when somebody with the right to
// asks. Encryption protects the data at rest; it does not decide who may be shown it, and it does not stop a lawful
// request from a partner institution being answered. That is reveal_kyc_id_number()'s job, with its audit entry.
//
// AES-256-GCM, because it authenticates as well as encrypts: a file that was altered on disk fails to open instead of
// opening as something else. Sealed form is `iv (12) | tag (16) | ciphertext`, one self-contained buffer, so the store
// that holds it needs to know nothing about how it was made.
//
// KEY ROTATION IS READY, NOT DONE. Every sealed value is stored beside the key's NAME (kyc_submissions.encryption_key_id),
// and KYC_ENCRYPTION_KEYS can carry several `id:base64` pairs — the first seals, any of them opens — so adding a new key
// and re-sealing old rows is a loop, not a migration. Moving the keys out of .env into a secrets manager is the same
// change at the one place `keyring()` reads them.
//
// THREE SECRETS, THREE JOBS:
//   KYC_ENCRYPTION_KEY(S)   seals the files and the ID number.
//   KYC_FINGERPRINT_PEPPER  keys the duplicate-detection hash. Separate from the encryption key on purpose: the pepper
//                           is used on every submission, the encryption key only to seal and open, and a leak of one
//                           should not be a leak of the other.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export const DEFAULT_KEY_ID = 'env-1';

type Keyring = { current: { id: string; key: Buffer }; byId: Map<string, Buffer> };

function parseKey(id: string, base64: string): Buffer {
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(`KYC encryption key "${id}" must be 32 bytes, base64-encoded (got ${key.length}). Generate one with: openssl rand -base64 32`);
  }
  return key;
}

/** Read on every call, not at import: the server loads .env after its modules are evaluated (see api/env.ts). */
function keyring(): Keyring {
  const many = process.env['KYC_ENCRYPTION_KEYS'];
  const one = process.env['KYC_ENCRYPTION_KEY'];
  const entries: { id: string; key: Buffer }[] = [];

  if (many !== undefined && many.trim() !== '') {
    for (const pair of many.split(',')) {
      const at = pair.indexOf(':');
      if (at <= 0) throw new Error('KYC_ENCRYPTION_KEYS is a comma-separated list of id:base64key pairs.');
      entries.push({ id: pair.slice(0, at).trim(), key: parseKey(pair.slice(0, at).trim(), pair.slice(at + 1)) });
    }
  } else if (one !== undefined && one.trim() !== '') {
    entries.push({ id: process.env['KYC_ENCRYPTION_KEY_ID']?.trim() || DEFAULT_KEY_ID, key: parseKey(DEFAULT_KEY_ID, one) });
  }

  const current = entries[0];
  if (current === undefined) {
    throw new Error(
      'KYC_ENCRYPTION_KEY is not set, so identity documents cannot be stored. Generate one with `openssl rand -base64 32` ' +
        'and put it in server/.env. Losing it makes every stored document unreadable — keep a copy somewhere safe.',
    );
  }
  return { current, byId: new Map(entries.map((e) => [e.id, e.key])) };
}

/** True when the key is configured — the route answers "not set up" rather than crashing mid-upload. */
export function kycEncryptionConfigured(): boolean {
  try {
    keyring();
    return true;
  } catch {
    return false;
  }
}

export type Sealed = { bytes: Buffer; keyId: string };

export function seal(plain: Uint8Array): Sealed {
  const { current } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { bytes: Buffer.concat([iv, cipher.getAuthTag(), body]), keyId: current.id };
}

export function open(sealed: Uint8Array, keyId: string): Buffer {
  const key = keyring().byId.get(keyId);
  if (key === undefined) throw new Error(`no key named "${keyId}" is configured, so that document cannot be opened`);
  const buf = Buffer.from(sealed);
  if (buf.length < 28) throw new Error('sealed value is too short to be one');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  // final() throws if the tag does not match: a tampered file is an error, never a different file.
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

// ---------------------------------------------------------------------------
// The ID number
// ---------------------------------------------------------------------------

/** Spaces and dashes are how people write it, not part of it. */
export const normaliseIdNumber = (raw: string): string => raw.replace(/[\s-]/g, '').toUpperCase();

/**
 * "1 1994 7 ••••••• 0 18" is AdminKYC's own example: the first and last few characters stay so a reviewer can tell two
 * documents apart, and the middle is gone. A mask with nothing hidden is the number (V012 refuses it by constraint).
 */
export function maskIdNumber(raw: string): string {
  const n = normaliseIdNumber(raw);
  if (n.length < 6) return '•'.repeat(Math.max(3, n.length));
  const keep = Math.min(4, Math.floor(n.length / 4));
  return `${n.slice(0, keep)} ${'•'.repeat(n.length - keep * 2)} ${n.slice(-keep)}`;
}

/** What goes into kyc_submissions in one piece: ciphertext + the name of the key, the mask, and the fingerprint. */
export function sealIdNumber(raw: string): { encrypted: Buffer; keyId: string; masked: string; fingerprint: string } {
  const n = normaliseIdNumber(raw);
  const sealed = seal(Buffer.from(n, 'utf8'));
  return { encrypted: sealed.bytes, keyId: sealed.keyId, masked: maskIdNumber(n), fingerprint: fingerprintOf(n) };
}

export const revealIdNumber = (encrypted: Uint8Array, keyId: string): string => open(encrypted, keyId).toString('utf8');

/** A keyed hash: the same number gives the same value, and nobody can get from the value back to the number. */
export function fingerprintOf(raw: string): string {
  const pepper = process.env['KYC_FINGERPRINT_PEPPER'];
  if (pepper === undefined || pepper.length < 16) {
    throw new Error('KYC_FINGERPRINT_PEPPER is not set (16+ characters). Generate one with: openssl rand -hex 32');
  }
  return createHmac('sha256', pepper).update(normaliseIdNumber(raw)).digest('hex');
}
