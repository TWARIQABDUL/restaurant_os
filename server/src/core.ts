// server/src/core.ts — milestone 12.
//
// The ONE file that knows where @vendlyfy/core lives, the same arrangement as db/rows.ts for
// the generated row types. Everything else in server/src imports from here.
//
// WHY A RELATIVE PATH AND NOT THE PACKAGE NAME. §4.6 deferred npm workspaces to this
// milestone, on the grounds that "nothing imports it until milestone 12, so there is nothing
// to resolve yet". Something imports it now — and the argument the same section makes against
// workspaces has not expired:
//
//   "the old client and server deploy from their own directories, each with its own lockfile
//    (client/vercel.json, render.yaml with rootDir: server), and both must keep running
//    untouched until cutover. Restructuring node_modules underneath a live money system
//    months before anything needs it buys nothing."
//
// The legacy server still serves production until milestone 30. Making `@vendlyfy/core`
// resolvable by name from server/ means either a workspace root that changes what `npm ci`
// does, or a `file:../packages/core` dependency in the live server's package.json — and if
// either fails on Render, the money system stops deploying. What it buys is a shorter import
// specifier in this one file.
//
// So: a relative path now, and the package name at cutover, when the legacy server and its
// lockfile are deleted and there is nothing to break. It is one line to change, here.
//
// The imports are VALUES as well as types, so this module does resolve at run time — Node
// loads the .ts files directly and strips their types, which is the same mechanism db/scripts
// and db/seeds have used since milestone 2.

export {
  PLATFORM_WORDS,
  WORD_KEYS,
  bindConfig,
  isAlreadySingular,
  resolveConfig,
  singularize,
  wordKeys,
} from '../../packages/core/src/index.ts';

export type {
  Attribute,
  AttributePick,
  ConfigInputs,
  ConfigOverrides,
  ConfigSource,
  ConfigTemplate,
  EffectiveConfig,
  FeatureGate,
  ModuleDefinition,
  OrderStep,
  ResolvedModule,
  ResolvedWord,
  Vocabulary,
  WordForm,
  WordKey,
} from '../../packages/core/src/index.ts';
