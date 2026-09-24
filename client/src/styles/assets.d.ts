// Vite resolves a CSS import for its side effect; TypeScript has to be told such
// a module exists.
//
// `vite/client` declares this already, but adding it to the client tsconfig's
// "types" would pull @types/node back in through Vite's own type references —
// which is exactly what that empty "types": [] is there to prevent, so that
// browser code reaching for `process` or `Buffer` fails to compile. One line here
// is cheaper than losing that guard.
declare module '*.css';
