// server/src/db/index.ts — milestone 11.
//
// What the rest of the new stack imports. A route never touches pg; a repository
// never opens a connection.

export { assertDatabaseConfig, closePool, db, getPool, ping, sql } from './pool.ts';
export type { Queryable } from './pool.ts';
export { currentTx, readConsistent, requireTx, withTransaction } from './tx.ts';
export type { Tx, TxOptions } from './tx.ts';
export {
  AppError,
  badRequest,
  conflict,
  forbidden,
  isPgError,
  isRetryable,
  notFound,
  sqlstate,
  toAppError,
  unauthorized,
} from './errors.ts';
