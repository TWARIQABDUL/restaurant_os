// server/src/api/validate.ts — milestone 11.
//
// Request-body reading that produces a typed value or a 400 naming the field.
//
// Hand-written rather than express-validator, for one reason: these return narrowed
// TypeScript types. `const name = requiredString(body, 'name')` is a `string` to the
// compiler, so a handler cannot forget that a field was optional — which is the class
// of bug that reaches the database as a not-null violation and comes back as a 500.
//
// The DATABASE is still the authority on what is valid: users_email_shape, the slug
// format, every role list. These checks exist to give a better message than a
// translated constraint name, never to replace one. Anything that got past here and is
// still refused is db/errors.ts' job.

import { badRequest } from '../db/index.ts';

export type Body = Record<string, unknown>;

/** Express gives `{}` for an absent JSON body, and `undefined` if the parser did not run. */
export function bodyOf(value: unknown): Body {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('Expected a JSON object.');
  }
  return value as Body;
}

export function requiredString(
  body: Body,
  field: string,
  opts: { min?: number; max?: number } = {},
): string {
  const raw = body[field];
  if (typeof raw !== 'string') throw badRequest(`${field} is required.`, 'MISSING_FIELD');
  const value = raw.trim();
  if (value === '') throw badRequest(`${field} is required.`, 'MISSING_FIELD');
  if (opts.min !== undefined && value.length < opts.min) {
    throw badRequest(`${field} must be at least ${opts.min} characters.`, 'TOO_SHORT');
  }
  if (opts.max !== undefined && value.length > opts.max) {
    throw badRequest(`${field} must be at most ${opts.max} characters.`, 'TOO_LONG');
  }
  return value;
}

/** An absent field and an explicitly null one are the same thing: no value. */
export function optionalString(body: Body, field: string, opts: { max?: number } = {}): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw badRequest(`${field} must be text.`, 'INVALID');
  const value = raw.trim();
  if (value === '') return null;
  if (opts.max !== undefined && value.length > opts.max) {
    throw badRequest(`${field} must be at most ${opts.max} characters.`, 'TOO_LONG');
  }
  return value;
}

/**
 * Deliberately permissive, and the same shape as users_email_shape: something, an @,
 * something, a dot, something, no spaces. A stricter regex rejects real addresses, and
 * the only test that matters is whether mail arrives.
 */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function requiredEmail(body: Body, field = 'email'): string {
  const value = requiredString(body, field, { max: 254 });
  if (!EMAIL.test(value)) throw badRequest('That does not look like an email address.', 'INVALID_EMAIL');
  // Stored as given, compared with lower(). V001's unique indexes are on
  // lower(email), so case is not identity — but a person's own capitalisation of
  // their address is theirs to keep.
  return value;
}

export function requiredOneOf<T extends string>(
  body: Body,
  field: string,
  allowed: readonly T[],
): T {
  const value = requiredString(body, field);
  if (!(allowed as readonly string[]).includes(value)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`, 'INVALID_VALUE');
  }
  return value as T;
}

/**
 * A positive integer from a query string. Returns null when absent, so the caller's
 * own default applies rather than one chosen here.
 */
export function optionalPositiveInt(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw badRequest(`${field} must be a number.`, 'INVALID');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw badRequest(`${field} must be a whole number above zero.`, 'INVALID');
  }
  return value;
}

/** An ISO timestamp from a query string — a keyset cursor. */
export function optionalTimestamp(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest(`${field} must be a timestamp.`, 'INVALID');
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw badRequest(`${field} must be a timestamp.`, 'INVALID');
  return new Date(parsed).toISOString();
}
