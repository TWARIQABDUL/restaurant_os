// server/src/api/env.ts — milestone 11.
//
// Loads server/.env, and it is imported FIRST by the entrypoint on purpose.
//
// ESM executes imports in order before the importing module's own body, so a
// `dotenv.config()` call in server.ts' body runs AFTER every module it imports has
// already initialised — and anything one of them read from process.env at module scope
// would have read it from an environment the file had not been loaded into yet. Putting
// the load in its own module and importing it first is what makes the ordering a
// guarantee rather than a hope.
//
// The path is resolved from THIS FILE, not from the working directory. `dotenv/config`
// reads ./.env relative to cwd, which would mean `node server/src/api/server.ts` from the
// repository root and `npm run api:start` from server/ load different files — the same
// command configured two ways depending on where it was typed.
//
// Variables already present win: dotenv never overwrites, which is what a deployment
// relies on.
//
// ENV_FILE overrides the path, and it is not a convenience — it is what makes the boot
// refusals testable. test/api/boot.test.ts asserts that the server will not start without
// APP_DATABASE_URL; with the path fixed, a developer's own server/.env supplies one and
// that test can never see the condition it is about. A deployment that keeps its file
// elsewhere gets the same knob. A path that does not exist is not an error: dotenv reads
// nothing and the process environment stands on its own, which is how a deployment with no
// file at all already works.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ENV_FILE = process.env.ENV_FILE ?? path.join(SERVER_ROOT, '.env');

dotenv.config({ path: ENV_FILE, quiet: true });

export { ENV_FILE, SERVER_ROOT };
