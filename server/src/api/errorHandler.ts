// server/src/api/errorHandler.ts — milestone 11.
//
// The one place a failure becomes a response. Two rules:
//
//   1. NOTHING LEAKS. An AppError's message reaches the client only when `expose` says
//      so, which db/errors.ts decides per SQLSTATE rather than per status code — because
//      VLSTK's "Grilled Chicken has 2 left, not 5" is written for a customer while
//      VLFND's names a pot and a store id. Everything else is a fixed sentence and a
//      log line.
//
//   2. EVERY 5xx IS LOGGED WITH ITS DETAIL, including the SQLSTATE and constraint name
//      that did not go out. A 500 whose cause is only in the response body is a 500
//      nobody can fix.

import { randomBytes } from 'node:crypto';
import type { ErrorRequestHandler } from 'express';
import { AppError, isPgError, toAppError } from '../db/index.ts';

/**
 * Failures raised by Express' own middleware before any route runs. body-parser throws
 * these, and they are the one class of error that arrives already knowing its status:
 *
 *   entity.parse.failed    400  malformed JSON
 *   entity.too.large       413  past express.json's 200kb limit
 *   encoding.unsupported   415  a Content-Encoding we do not accept
 *   charset.unsupported    415
 *
 * Without this they fall through to toAppError(), which sees no SQLSTATE and answers 500
 * — so a request body one byte over the limit would read as "our fault" instead of "too
 * big", and the caller would retry it forever.
 */
const PARSER_MESSAGES: Readonly<Record<string, string>> = {
  'entity.parse.failed': 'That request body is not valid JSON.',
  'entity.too.large': 'That request is too large.',
  'encoding.unsupported': 'That content encoding is not supported.',
  'charset.unsupported': 'That character set is not supported.',
  'request.aborted': 'The request ended before it was complete.',
  'request.size.invalid': 'The request body did not match its Content-Length.',
};

const PARSER_CODES: Readonly<Record<string, string>> = {
  'entity.parse.failed': 'INVALID_JSON',
  'entity.too.large': 'BODY_TOO_LARGE',
  'encoding.unsupported': 'UNSUPPORTED_ENCODING',
  'charset.unsupported': 'UNSUPPORTED_CHARSET',
  'request.aborted': 'REQUEST_ABORTED',
  'request.size.invalid': 'INVALID_CONTENT_LENGTH',
};

type ParserError = { type?: unknown; status?: unknown; statusCode?: unknown };

/**
 * Reads a status and a message off an Express-layer error, or null if it is not one.
 *
 * The status is taken from the error rather than from the `type` table, so an error kind
 * that table does not name still gets its own status instead of a 500. It is clamped to
 * 4xx: a 5xx from a parser is ours, and belongs in the log with a generic message.
 */
function fromExpress(err: unknown): { status: number; code: string; message: string } | null {
  if (typeof err !== 'object' || err === null || isPgError(err) || err instanceof AppError) return null;

  const e = err as ParserError;
  const raw = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null;
  if (raw === null || raw < 400 || raw > 499) return null;

  const type = typeof e.type === 'string' ? e.type : '';
  return {
    status: raw,
    code: PARSER_CODES[type] ?? 'BAD_REQUEST',
    message: PARSER_MESSAGES[type] ?? 'That request could not be read.',
  };
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Headers already sent: the response is committed and Express' default handler must
  // destroy the socket. Writing a body here would corrupt whatever was streaming.
  if (res.headersSent) {
    next(err);
    return;
  }

  const fromParser = fromExpress(err);
  const appError = toAppError(err);

  const status = fromParser === null ? appError.status : fromParser.status;
  const where = `${req.method} ${req.originalUrl}`;

  // A REFERENCE FOR EVERY SERVER ERROR (AdminStates: "Errors always give a reference so support can find the failed request"). Random, not
  // derived from anything private, printed in the log line AND returned to the person — so what they read out over the phone is a string
  // a grep finds. 4xx are the caller's to fix and get none.
  const reference = status >= 500 ? `ERR-${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}` : null;

  if (status >= 500) {
    console.error(`[api] ${status} ${where} — ${appError.message} [${reference}]`, {
      code: appError.code,
      detail: appError.detail,
      cause: appError.cause instanceof Error ? appError.cause.stack : appError.cause,
    });
  } else if (appError.detail !== undefined) {
    // A 4xx with a database detail is a refused write — worth a line, not a stack.
    console.warn(`[api] ${status} ${where} — ${appError.code}: ${appError.detail}`);
  }

  const body: { error: string; code: string; hint?: string; reference?: string } =
    fromParser === null
      ? {
          error: appError.expose ? appError.message : 'Something went wrong on our side.',
          code: appError.code,
        }
      : { error: fromParser.message, code: fromParser.code };

  if (fromParser === null && appError.expose && appError.hint !== undefined) body.hint = appError.hint;

  if (reference !== null) body.reference = reference;

  res.status(status).json(body);
};

/** Thrown by the catch-all middleware for a path no router claimed. */
export function unmatchedRoute(): AppError {
  return new AppError({ status: 404, code: 'NO_SUCH_ROUTE', message: 'No such endpoint.' });
}
