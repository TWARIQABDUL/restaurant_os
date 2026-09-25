// server/src/api/handler.ts — milestone 11.
//
// Express 4 does not catch a rejected promise from a handler: the rejection becomes
// an unhandled rejection and the request hangs until the client gives up. Every async
// handler and every async middleware in the new stack is wrapped, so a thrown AppError
// reaches the error handler and a bug reaches the log instead of the void.
//
// Express 5 does this itself. When the server moves to it, this file is deleted and
// the wraps come off — which is why it is one function and not a framework.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
