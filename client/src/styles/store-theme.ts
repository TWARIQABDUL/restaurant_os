/**
 * Runtime plumbing for the nine per-store tokens — milestone 4.
 *
 * The fixed tokens live in tokens.css and are compiled at build time. These nine
 * cannot be: there is one bundle and thousands of stores, so they are CSS custom
 * properties written onto an element at runtime. This module is the only thing
 * that writes them.
 *
 * WHERE THIS DOES NOT LIVE: packages/core. That package is compiled with no DOM
 * lib precisely so it stays isomorphic, and this touches the DOM. The theme
 * *compiler* — eight inputs to these nine values, with contrast enforcement — is
 * core's job at milestone 13. This file only applies what the compiler produced,
 * and it must never derive a value of its own: the API re-runs the compiler on
 * publish and rejects any token set that is not its own output, which is what
 * makes ThemeStudio's promise that no store can publish something unreadable
 * true.
 *
 * Applying to an element rather than only to :root is required by the design:
 * StorePreview shows one store's theme inside the merchant console, and
 * ThemeStudio shows a live preview — both are subtrees themed differently from
 * the page around them. tokens.css uses `@theme inline` so that works; see the
 * comment there.
 */

/** The nine, in the order the canvas's ThemeStudio lists them. */
export const STORE_TOKEN_NAMES = [
  'bg',
  'surface',
  'text',
  'muted',
  'border',
  'primary',
  'onPrimary',
  'accent',
  'tint',
] as const;

export type StoreTokenName = (typeof STORE_TOKEN_NAMES)[number];

/** A complete, compiled theme. Partial themes are not a thing: a published theme
 *  always carries all nine, and half of one would render as a mix of two stores. */
export type StoreTheme = Readonly<Record<StoreTokenName, string>>;

/** Token name to the custom property tokens.css reads. */
const CSS_VARIABLE: Readonly<Record<StoreTokenName, string>> = {
  bg: '--store-bg',
  surface: '--store-surface',
  text: '--store-text',
  muted: '--store-muted',
  border: '--store-border',
  primary: '--store-primary',
  onPrimary: '--store-on-primary',
  accent: '--store-accent',
  tint: '--store-tint',
};

/** #rgb or #rrggbb. The compiler emits hex; anything else is a bug upstream, and
 *  a value with a brace or a semicolon in it has no business reaching a
 *  stylesheet even though setProperty cannot be escaped out of. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export type ThemeRejection = { readonly token: StoreTokenName; readonly value: unknown; readonly reason: string };

export type ApplyResult = {
  readonly applied: readonly StoreTokenName[];
  readonly rejected: readonly ThemeRejection[];
};

/**
 * Write a compiled theme onto `target`.
 *
 * Never throws, and never applies a value it does not recognise. A bad theme must
 * degrade to the platform default in tokens.css, not take a store's shopfront
 * offline — so a rejected token is left unset and reported, and the caller
 * decides whether that is worth surfacing.
 */
export function applyStoreTheme(
  theme: StoreTheme,
  target: HTMLElement = document.documentElement,
): ApplyResult {
  const applied: StoreTokenName[] = [];
  const rejected: ThemeRejection[] = [];

  for (const token of STORE_TOKEN_NAMES) {
    const value = theme[token];
    if (typeof value !== 'string' || !HEX.test(value)) {
      rejected.push({ token, value, reason: 'not a #rgb or #rrggbb colour' });
      continue;
    }
    target.style.setProperty(CSS_VARIABLE[token], value);
    applied.push(token);
  }

  return { applied, rejected };
}

/** Remove the overrides, falling back to the platform default in tokens.css. */
export function clearStoreTheme(target: HTMLElement = document.documentElement): void {
  for (const token of STORE_TOKEN_NAMES) {
    target.style.removeProperty(CSS_VARIABLE[token]);
  }
}

/**
 * What is actually in effect on `target`, resolved through the cascade — so this
 * returns the platform default where nothing has been applied, which is what
 * makes it useful for a test or a bug report rather than just an echo.
 */
export function readStoreTheme(target: HTMLElement = document.documentElement): StoreTheme {
  const computed = getComputedStyle(target);
  const out: Record<StoreTokenName, string> = {
    bg: '', surface: '', text: '', muted: '', border: '',
    primary: '', onPrimary: '', accent: '', tint: '',
  };
  for (const token of STORE_TOKEN_NAMES) {
    out[token] = computed.getPropertyValue(CSS_VARIABLE[token]).trim();
  }
  return out;
}

export type ParseResult =
  | { readonly ok: true; readonly theme: StoreTheme }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * The boundary. A theme arrives as JSON from the API, which means it arrives as
 * `unknown` — §2.5 makes the server authoritative, and that is only worth
 * anything if the client stops trusting the shape of what it is handed.
 */
export function parseStoreTheme(value: unknown): ParseResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, errors: ['theme is not an object'] };
  }
  const source = value as Record<string, unknown>;
  const errors: string[] = [];
  const draft: Record<StoreTokenName, string> = {
    bg: '', surface: '', text: '', muted: '', border: '',
    primary: '', onPrimary: '', accent: '', tint: '',
  };

  for (const token of STORE_TOKEN_NAMES) {
    const candidate = source[token];
    if (candidate === undefined) {
      errors.push(`${token} is missing`);
    } else if (typeof candidate !== 'string' || !HEX.test(candidate)) {
      errors.push(`${token} is not a #rgb or #rrggbb colour`);
    } else {
      draft[token] = candidate;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, theme: draft };
}
