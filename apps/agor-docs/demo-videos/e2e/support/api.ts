// A small REST client for the scratch daemon: what seeds and clips use to
// set up state off camera. Never pointed at anything but DAEMON_URL.

import { DAEMON_URL } from './harness.ts';

export interface Session {
  accessToken: string;
  refreshToken?: string;
}

type Query = Record<string, string | number | boolean | undefined>;

function qs(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export class AgorApi {
  private constructor(readonly session: Session) {}

  static async login(email: string, password: string): Promise<AgorApi> {
    const res = await fetch(`${DAEMON_URL}/authentication`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'local', email, password }),
    });
    if (!res.ok) throw new Error(`login as ${email} failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as Session;
    if (!body.accessToken) throw new Error(`login as ${email} returned no accessToken`);
    return new AgorApi({ accessToken: body.accessToken, refreshToken: body.refreshToken });
  }

  private async call<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const res = await fetch(`${DAEMON_URL}${path}${qs(query)}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.session.accessToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.call<T>('GET', path, undefined, query);
  }

  /** A Feathers find: unwraps `{ data }` pages and asks for a big page. */
  async find<T>(path: string, query: Query = {}): Promise<T[]> {
    const body = await this.call<T[] | { data: T[] }>('GET', path, undefined, {
      $limit: 500,
      ...query,
    });
    return Array.isArray(body) ? body : body.data;
  }

  post<T>(path: string, body: unknown, query?: Query): Promise<T> {
    return this.call<T>('POST', path, body, query);
  }

  patch<T>(path: string, body: unknown, query?: Query): Promise<T> {
    return this.call<T>('PATCH', path, body, query);
  }

  remove<T>(path: string, query?: Query): Promise<T> {
    return this.call<T>('DELETE', path, undefined, query);
  }
}
