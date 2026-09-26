// client/src/app/api.ts — milestone 15.
//
// The one way this app talks to the server, and the reason it is one function is §2.5:
//
//   "the server is authoritative for all session and application state. Browser storage is never the
//    source of truth, and every screen must render correctly with it empty, blocked or unavailable."
//
// SO THERE IS NO STORAGE HERE AT ALL. No localStorage, no sessionStorage, no in-memory user cache. The
// session is an httpOnly cookie the browser sends and this code cannot read; who you are comes from
// GET /api/session on every load. The store comes from the URL, never from a remembered slug — which
// also deletes the bug the audit found, where one mistyped URL poisoned the tenant header for every
// later request in that browser.
//
// THE CSRF TOKEN IS READ FROM A COOKIE AND ECHOED IN A HEADER. That cookie is not httpOnly, because the
// echo is the whole mechanism (server/src/auth/csrf.ts). It is not "storage as a source of truth": the
// server issued it, the server verifies the pair, and a forged value fails.

export type ApiError = {
  status: number;
  code: string;
  message: string;
  hint?: string;
};

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiFailure';
    this.status = error.status;
    this.code = error.code;
    this.hint = error.hint;
  }
}

const CSRF_COOKIE = 'csrf';

/** The csrf token the server set. Absent on a first load before any response has arrived. */
function csrfToken(): string | null {
  // document.cookie can throw in a sandboxed frame, and returns '' where cookies are blocked. Either
  // way the request goes out without the header and the server answers 403 with something a person can
  // act on — which is better than this function deciding the page is broken.
  try {
    for (const part of document.cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === CSRF_COOKIE) return rest.join('=');
    }
  } catch {
    return null;
  }
  return null;
}

const SAFE = new Set(['GET', 'HEAD']);

/**
 * One request.
 *
 * `credentials: 'include'` is what sends the session cookie. It is required rather than incidental: the
 * API is same-origin under each store's host by design (§2.5's note on cookie scope), and without this
 * a cross-origin dev setup silently sends no session and every screen looks signed out.
 */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (!SAFE.has(method)) {
    const token = csrfToken();
    if (token !== null) headers['X-CSRF-Token'] = token;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // States.dc.html's "You're offline". A network failure is not a server error, and saying so is what
    // lets the screen offer "Retry now" instead of "Something went wrong".
    throw new ApiFailure({ status: 0, code: 'OFFLINE', message: 'You’re offline.' });
  }

  const text = await res.text();
  let payload: Record<string, unknown> = {};
  if (text !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }

  if (!res.ok) {
    throw new ApiFailure({
      status: res.status,
      code: typeof payload['code'] === 'string' ? payload['code'] : 'UNKNOWN',
      message:
        typeof payload['error'] === 'string' ? payload['error'] : 'Something went wrong. Please try again.',
      ...(typeof payload['hint'] === 'string' ? { hint: payload['hint'] } : {}),
    });
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body ?? {}),
  delete: <T>(path: string): Promise<T> => request<T>('DELETE', path),
};

// ---------------------------------------------------------------------------
// The shapes the auth screens read
// ---------------------------------------------------------------------------

export type Membership = {
  storeId: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'manager' | 'rider';
};

export type SignInResult =
  | { next: 'ready'; user: { id: string; name: string; email: string; scope: string }; memberships: Membership[] }
  | { next: 'choose-store'; user: { id: string; name: string; email: string; scope: string }; memberships: Membership[] }
  | { next: 'two-step'; userId: string; sentTo: string; expiresAt: string };

export type SessionResult = {
  user: { id: string; name: string; email: string; scope: string; customerStoreId: string | null };
  platformRole: string | null;
  memberships: Membership[];
};

export type InviteResult = {
  invite: {
    store: { name: string; slug: string };
    email: string;
    name: string;
    role: 'admin' | 'manager' | 'rider';
    invitedBy: string | null;
    expiresAt: string;
  };
  hasAccount: boolean;
  passwordRules: string[];
};
