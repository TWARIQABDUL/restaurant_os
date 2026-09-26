// server/src/db/errors.ts — milestone 11.
//
// One place that decides what a database failure means to a caller, so no route
// has to read a SQLSTATE and no route can leak one.
//
// THE SCHEMA IS THE AUTHORITY, so this file does not re-implement its rules — it
// translates the refusals. Fourteen migrations put 1,009 assertions' worth of
// invariants in the database precisely so that a missed check in application code
// cannot corrupt anything; the price of that is that the application must read
// the refusals properly.
//
// Four custom SQLSTATEs are Vendlyfy's own (V005, V008, V012, V018):
//
//   VLSTK  insufficient stock  — "Grilled Chicken has 2 left, not 5"
//   VLFND  insufficient funds  — a pot would go negative
//   VLHLD  payouts held        — unverified store, or a refund queued ahead of it
//   VLCAT  stale catalogue     — the page is out of date: that variant or option is gone
//
// VLSTK, VLHLD and VLCAT carry MESSAGE and HINT text written for a person to read, so
// they are passed through. VLFND's message names the pot and the store id and is
// written for an operator: it is logged and replaced. That distinction is the
// whole reason `expose` exists below rather than a blanket rule.
//
// VLCAT was added at milestone 16 after the storefront's add-to-cart refusals came back as the generic
// P0001 sentence. A shopper whose page has gone stale needs "reload the page", and the function that
// refused them had already written it.

/** Postgres' own codes, named where we act on them. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const CHECK_VIOLATION = '23514';
const EXCLUSION_VIOLATION = '23P01';
const INVALID_TEXT_REPRESENTATION = '22P02';
const NUMERIC_VALUE_OUT_OF_RANGE = '22003';
const STRING_DATA_RIGHT_TRUNCATION = '22001';
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';
const ADMIN_SHUTDOWN = '57P01';
const CANNOT_CONNECT_NOW = '57P03';
const TOO_MANY_CONNECTIONS = '53300';
const INSUFFICIENT_PRIVILEGE = '42501';
const RAISE_EXCEPTION = 'P0001';

const INSUFFICIENT_STOCK = 'VLSTK';
const INSUFFICIENT_FUNDS = 'VLFND';
const PAYOUTS_HELD = 'VLHLD';
const STALE_CATALOGUE = 'VLCAT';

/**
 * A transaction that failed for a reason that re-running can fix. withTransaction()
 * retries exactly these and nothing else — a retry of anything else repeats a
 * decision the database already made.
 */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  SERIALIZATION_FAILURE,
  DEADLOCK_DETECTED,
  LOCK_NOT_AVAILABLE,
]);

// ---------------------------------------------------------------------------
// The error the routes throw and the handler serialises
// ---------------------------------------------------------------------------

/**
 * `expose` is the only thing standing between a Postgres message and an HTTP
 * response body. It is opt-in per error, never per status code.
 *
 * No parameter properties: `erasableSyntaxOnly` rejects them (tsconfig.base.json).
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;
  readonly hint: string | undefined;
  readonly detail: string | undefined;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    expose?: boolean;
    hint?: string;
    detail?: string;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.status = opts.status;
    this.code = opts.code;
    this.expose = opts.expose ?? true;
    this.hint = opts.hint;
    this.detail = opts.detail;
  }
}

export function badRequest(message: string, code = 'BAD_REQUEST'): AppError {
  return new AppError({ status: 400, code, message });
}

export function unauthorized(message = 'Not signed in', code = 'UNAUTHENTICATED'): AppError {
  return new AppError({ status: 401, code, message });
}

export function forbidden(message = 'Not allowed', code = 'FORBIDDEN'): AppError {
  return new AppError({ status: 403, code, message });
}

export function notFound(message = 'Not found', code = 'NOT_FOUND'): AppError {
  return new AppError({ status: 404, code, message });
}

export function conflict(message: string, code = 'CONFLICT'): AppError {
  return new AppError({ status: 409, code, message });
}

// ---------------------------------------------------------------------------
// Reading a pg error
// ---------------------------------------------------------------------------

/**
 * The fields node-postgres copies off a Postgres error. Declared rather than
 * imported: pg's DatabaseError is a class, and narrowing on a shape lets a
 * plain object from a test or a driver wrapper be read the same way.
 */
type PgErrorShape = {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  hint?: unknown;
  constraint?: unknown;
  table?: unknown;
  column?: unknown;
  schema?: unknown;
  routine?: unknown;
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** A database error with a SQLSTATE, whatever class it arrived as. */
export function isPgError(err: unknown): err is PgErrorShape & { code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as PgErrorShape).code === 'string' &&
    // A SQLSTATE is five characters. Node's own errors also carry a `code`
    // (ECONNREFUSED, ERR_INVALID_ARG_TYPE), and treating one of those as a
    // SQLSTATE is how a connection failure turns into a nonsense 400.
    (((err as PgErrorShape).code as string).length === 5)
  );
}

export function sqlstate(err: unknown): string | null {
  return isPgError(err) ? err.code : null;
}

export function isRetryable(err: unknown): boolean {
  const code = sqlstate(err);
  return code !== null && RETRYABLE_SQLSTATES.has(code);
}

/**
 * True when the client can no longer be trusted and must be destroyed rather
 * than returned to the pool: the backend went away mid-transaction, so its
 * session state is unknown.
 */
export function isConnectionLost(err: unknown): boolean {
  const code = sqlstate(err);
  if (code === ADMIN_SHUTDOWN || code === CANNOT_CONNECT_NOW) return true;
  if (code !== null) return false;

  const message = err instanceof Error ? err.message : '';
  return /Connection terminated|connection ended|socket hang up|ECONNRESET|ETIMEDOUT/i.test(message);
}

// ---------------------------------------------------------------------------
// Constraint names a caller is entitled to a specific answer about
// ---------------------------------------------------------------------------
//
// A unique violation is a 409, but "which uniqueness" decides what to say. These
// are the constraints the endpoints in this milestone can actually hit; adding a
// route means adding its constraints here rather than widening the default, so
// that a new conflict is never described with another one's words.

const UNIQUE_MESSAGES: Readonly<Record<string, string>> = {
  users_platform_email_key: 'Someone already has an account with that email address.',
  users_store_email_key: 'That email address already has an account at this store.',
  store_members_pkey: 'That person is already a member of this store.',
  store_members_user_store_role_key: 'That person already holds that role in this store.',
  stores_slug_key: 'That store address is already taken.',
  stores_custom_domain_key: 'That domain is already connected to another store.',
  rider_profiles_store_plate_key: 'Another rider at this store already has that plate number.',
  withdrawals_idempotency_key: 'That payout request has already been recorded.',
};

const CHECK_MESSAGES: Readonly<Record<string, string>> = {
  stores_slug_not_reserved:
    'That store address is reserved by Vendlyfy. Please choose another.',
  stores_slug_format:
    'A store address may use lower-case letters, digits and single hyphens only.',
  stores_slug_length: 'A store address must be between 2 and 63 characters.',
  users_email_shape: 'That does not look like an email address.',
  users_scope_store_agree: 'A customer account must belong to a store, and a staff account must not.',
  store_members_role_values: 'That is not a role this store can grant.',
  store_members_user_is_platform_scoped:
    'A customer account cannot be given staff access. Staff sign in with a separate account.',
  platform_members_role_values: 'That is not a Vendlyfy team role.',
};

// ---------------------------------------------------------------------------
// The translation
// ---------------------------------------------------------------------------

/**
 * Turns anything thrown below the routes into an AppError. Pass it whatever you
 * caught; it returns an AppError unchanged, so wrapping is idempotent and a route
 * may translate early without the handler translating twice.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (!isPgError(err)) {
    const message = err instanceof Error ? err.message : String(err);
    return new AppError({
      status: 500,
      code: 'INTERNAL',
      message: 'Something went wrong on our side.',
      expose: false,
      detail: message,
      cause: err,
    });
  }

  const code = err.code;
  const constraint = str(err.constraint);
  const pgMessage = str(err.message);
  const pgHint = str(err.hint);
  const pgDetail = str(err.detail);

  // The trail an operator needs, kept off every response body.
  const detail = [
    `sqlstate=${code}`,
    constraint ? `constraint=${constraint}` : null,
    str(err.table) ? `table=${str(err.table)}` : null,
    pgMessage ? `message=${pgMessage}` : null,
    pgDetail ? `detail=${pgDetail}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  // --- Vendlyfy's own codes ------------------------------------------------
  //
  // Written to be read by the person who hit them, so message and hint go
  // through as they are. VLFND is the exception and says why.
  if (code === INSUFFICIENT_STOCK) {
    return new AppError({
      status: 409,
      code: 'INSUFFICIENT_STOCK',
      message: pgMessage ?? 'There is not enough stock left.',
      ...(pgHint === undefined ? {} : { hint: pgHint }),
      detail,
      cause: err,
    });
  }

  if (code === STALE_CATALOGUE) {
    return new AppError({
      // 409 rather than 404: the product may well exist, and what actually happened is that the page
      // the shopper is looking at disagrees with the catalogue. The code is distinct so a client can
      // refetch rather than only apologise.
      status: 409,
      code: 'STALE_CATALOGUE',
      message: pgMessage ?? 'That is not on sale here any more.',
      ...(pgHint === undefined ? {} : { hint: pgHint }),
      detail,
      cause: err,
    });
  }

  if (code === PAYOUTS_HELD) {
    return new AppError({
      status: 409,
      code: 'PAYOUTS_HELD',
      message: pgMessage ?? 'Payouts are paused for this store.',
      ...(pgHint === undefined ? {} : { hint: pgHint }),
      detail,
      cause: err,
    });
  }

  if (code === INSUFFICIENT_FUNDS) {
    // 'store <uuid> has -300.00 in its available pot, which cannot cover 300.00'
    // is an operator's sentence, not a merchant's. The hint is the part written
    // for a person, so it is the part that goes out.
    return new AppError({
      status: 409,
      code: 'INSUFFICIENT_FUNDS',
      message: 'There is not enough in the balance to cover that.',
      ...(pgHint === undefined ? {} : { hint: pgHint }),
      detail,
      expose: true,
      cause: err,
    });
  }

  // --- constraint refusals -------------------------------------------------
  if (code === UNIQUE_VIOLATION || code === EXCLUSION_VIOLATION) {
    const known = constraint === undefined ? undefined : UNIQUE_MESSAGES[constraint];
    return new AppError({
      status: 409,
      code: 'CONFLICT',
      message: known ?? 'That already exists.',
      // An unmapped constraint name is a gap in this file, not something to
      // print: naming it would tell a caller about the schema and still not
      // tell them what to do.
      expose: true,
      detail,
      cause: err,
    });
  }

  if (code === CHECK_VIOLATION) {
    const known = constraint === undefined ? undefined : CHECK_MESSAGES[constraint];
    return new AppError({
      status: 400,
      code: 'INVALID',
      message: known ?? 'That value is not allowed.',
      detail,
      cause: err,
    });
  }

  if (code === FOREIGN_KEY_VIOLATION) {
    // Both directions arrive here: a reference to something that does not exist
    // (400 — the caller named it) and a delete blocked by RESTRICT (409 — the
    // caller's request conflicts with existing rows). Postgres distinguishes them
    // by which table the constraint is on, which is not reliably available, so
    // the routine name is used: ri_ReportViolation covers the insert side.
    const blocking = /still referenced|update or delete/i.test(pgDetail ?? pgMessage ?? '');
    return blocking
      ? new AppError({
          status: 409,
          code: 'IN_USE',
          message: 'That cannot be removed while other records still refer to it.',
          detail,
          cause: err,
        })
      : new AppError({
          status: 400,
          code: 'INVALID_REFERENCE',
          message: 'That refers to something that does not exist.',
          detail,
          cause: err,
        });
  }

  if (code === NOT_NULL_VIOLATION) {
    const column = str(err.column);
    return new AppError({
      status: 400,
      code: 'MISSING_FIELD',
      message: column === undefined ? 'A required value is missing.' : `${column} is required.`,
      detail,
      cause: err,
    });
  }

  if (code === INVALID_TEXT_REPRESENTATION) {
    // Most often a malformed uuid arriving from a path parameter. The routes
    // validate first, so reaching here means one got through.
    return new AppError({
      status: 400,
      code: 'INVALID',
      message: 'One of the values in that request is not in the expected format.',
      detail,
      cause: err,
    });
  }

  if (code === NUMERIC_VALUE_OUT_OF_RANGE || code === STRING_DATA_RIGHT_TRUNCATION) {
    return new AppError({
      status: 400,
      code: 'INVALID',
      message: 'One of the values in that request is too large.',
      detail,
      cause: err,
    });
  }

  // --- plain RAISE from a plpgsql function ---------------------------------
  //
  // P0001 with no custom SQLSTATE. The schema uses it for its own assertions
  // (the chain triggers, the discount total), whose messages are written for
  // whoever broke them — a developer. So: 409, and the text stays in the log.
  if (code === RAISE_EXCEPTION) {
    return new AppError({
      status: 409,
      code: 'REFUSED',
      message: 'That change was refused because it would leave the records inconsistent.',
      expose: true,
      detail,
      cause: err,
    });
  }

  // --- the database is unwell ----------------------------------------------
  if (code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED || code === LOCK_NOT_AVAILABLE) {
    // Reaching a route means withTransaction() already exhausted its retries.
    return new AppError({
      status: 503,
      code: 'BUSY',
      message: 'The system is busy. Please try that again.',
      detail,
      cause: err,
    });
  }

  if (code === QUERY_CANCELED) {
    // statement_timeout fired. A slow query is ours to fix, so this is logged
    // loudly and answered as a timeout rather than as a client error.
    return new AppError({
      status: 504,
      code: 'TIMEOUT',
      message: 'That took too long. Please try again.',
      expose: true,
      detail,
      cause: err,
    });
  }

  if (code === TOO_MANY_CONNECTIONS || code === ADMIN_SHUTDOWN || code === CANNOT_CONNECT_NOW) {
    return new AppError({
      status: 503,
      code: 'UNAVAILABLE',
      message: 'The service is temporarily unavailable. Please try again in a moment.',
      detail,
      cause: err,
    });
  }

  if (code === INSUFFICIENT_PRIVILEGE) {
    // The application role lacks a grant. Never the caller's fault, and never
    // something to describe to them.
    return new AppError({
      status: 500,
      code: 'INTERNAL',
      message: 'Something went wrong on our side.',
      expose: false,
      detail,
      cause: err,
    });
  }

  return new AppError({
    status: 500,
    code: 'INTERNAL',
    message: 'Something went wrong on our side.',
    expose: false,
    detail,
    cause: err,
  });
}
