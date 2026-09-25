// server/test/api/client.ts — milestone 11.
//
// Boots the real app on an ephemeral port and makes real HTTP requests to it.
//
// §5.4's third escalation test is explicit that a manager's refusal must be "verified
// against the endpoint, not against whether the nav item is hidden". Calling a handler
// function directly would skip the guard, the mount path and the error handler — the
// three things under test. So: a listening socket and fetch().

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/api/app.ts';
import { signSessionToken } from '../../src/auth/sessionToken.ts';

export type Api = {
  baseUrl: string;
  close: () => Promise<void>;
};

export async function boot(): Promise<Api> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined || err === null ? resolve() : reject(err)));
      }),
  };
}

export type Reply = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * One request. The token goes in the Authorization header rather than the cookie
 * because readToken() accepts both and a header needs no cookie jar — and milestone 15,
 * which owns the cookie flow, will test that path where it belongs.
 */
export async function call(
  api: Api,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { raw: parsed };
    } catch {
      body = { raw: text };
    }
  }

  return { status: res.status, body };
}

export function tokenFor(userId: string): string {
  return signSessionToken(userId);
}
