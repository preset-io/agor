/**
 * HTTP proxies — pass-through forwarding for third-party APIs.
 *
 * Mounts `/proxies/<vendor>/...` when `~/.agor/config.yaml` declares a
 * `proxies:` block. Anything sent to `/proxies/<vendor>/X` is forwarded as-is
 * to `<upstream>/X`, with bytes flowing both directions.
 *
 * Why this exists: Sandpack artifacts run inside `https://*.codesandbox.io`
 * iframes. Many enterprise REST APIs (Shortcut, Linear, Jira) return no
 * `Access-Control-Allow-Origin` headers at all, so a browser-side fetch
 * fails regardless of headers/preflight/library. The browser stack itself
 * enforces CORS — the only fix is server-side forwarding. The Agor daemon
 * already accepts CORS from `*.codesandbox.io`, so a route that forwards
 * bytes to a configured upstream solves it cleanly.
 *
 * This is a DUMB proxy. Five rules to enforce in code review:
 *   1. Pass-through bytes only — no transformation, no schema awareness, no caching.
 *   2. No vendor library — yaml-driven only, no built-in vendor presets.
 *   3. Read-only default — `allowed_methods` defaults to `[GET]`.
 *   4. Off by default — no `proxies:` block = no route mounted at all.
 *   5. No auth injection — daemon does not read user env vars or set auth
 *      headers. Auth stays in the artifact via the existing Handlebars
 *      convention (`agor.config.js`).
 */

import type { AgorConfig } from '@agor/core/config';
import { type ResolvedProxy, resolveProxies } from '@agor/core/config';
import type { Application } from '@agor/core/feathers';
import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';

/** Default per-(user, vendor) rate limit. In-memory bucket; no redis. */
const RATE_LIMIT_PER_MINUTE = 60;

/** Maximum response body size we'll relay back. Cap is conservative on purpose. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Hard upstream timeout. AbortSignal.timeout fires the abort, not a manual setTimeout. */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Headers stripped from the inbound request before forwarding to upstream.
 *
 * - `cookie`: Agor auth cookies must not leak to third parties.
 * - `host`: must reflect the upstream, not the daemon.
 * - `connection`, `content-length`: hop-by-hop / recomputed by `fetch`.
 */
const REQUEST_HEADER_STRIP = new Set(['cookie', 'host', 'connection', 'content-length']);

/**
 * Headers stripped from the upstream response before relaying to the caller.
 *
 * - `set-cookie`: never let upstream set cookies on the daemon's domain.
 * - `transfer-encoding`, `connection`: hop-by-hop.
 * - `content-length`: we may truncate or re-encode and don't want a stale value.
 */
const RESPONSE_HEADER_STRIP = new Set([
  'set-cookie',
  'transfer-encoding',
  'connection',
  'content-length',
]);

interface AuthedUser {
  user_id: string;
}

/**
 * Verify the Bearer JWT on the incoming request. Mirrors the verification
 * already done by FeathersJS for service-mounted routes (and by socketio.ts
 * for WebSocket connections) — kept inline here because the proxy is raw
 * Express middleware, not a Feathers service, so the `requireAuth` hook
 * doesn't apply.
 */
function authenticateRequest(req: Request, jwtSecret: string): AuthedUser | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = jwt.verify(match[1], jwtSecret, {
      issuer: 'agor',
      audience: 'https://agor.dev',
    }) as { sub?: string; type?: string };
    if (decoded.type !== undefined && decoded.type !== 'access') return null;
    if (!decoded.sub) return null;
    return { user_id: decoded.sub };
  } catch {
    return null;
  }
}

/** Concatenate `upstream` + path tail (which already starts with `/` or is empty). */
function buildUpstreamUrl(upstream: string, tail: string): string {
  // `tail` is whatever followed `/proxies/<vendor>` in the original URL,
  // including any querystring. `upstream` was normalized to have no trailing
  // slash. If the operator violated the bare-host convention and included a
  // path prefix, double-prefix collisions are documented as their problem.
  return upstream + tail;
}

/**
 * Build the response-body relay. Streams bytes from `upstream` → caller and
 * aborts if `MAX_RESPONSE_BYTES` is exceeded mid-stream. Returns `true` on
 * clean completion, `false` if the cap was hit (caller should send a 502).
 */
async function relayBody(
  upstreamRes: Response | globalThis.Response,
  res: Response
): Promise<boolean> {
  const body = (upstreamRes as globalThis.Response).body;
  if (!body) {
    res.end();
    return true;
  }

  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // best-effort
        }
        return false;
      }
      // Express's `res.write` returns false when the buffer is full; we
      // don't bother awaiting drain because the read loop above naturally
      // applies backpressure (the reader.read() promise resolves at the
      // pace the upstream stream supplies bytes).
      res.write(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  res.end();
  return true;
}

interface RegisterProxiesOptions {
  /** Override the default 60 req/min/vendor/user rate limit. Tests pass `0` to disable. */
  rateLimitPerMinute?: number;
}

/**
 * Mount `/proxies/<vendor>/...` if any vendors are configured.
 *
 * No-op when `config.proxies` is absent or empty: the route is not mounted
 * at all, so an unauthenticated probe sees a 404 from the default handler
 * rather than a 401 from the proxy. This is intentional — operators who
 * haven't configured proxies should not surface the feature in their attack
 * surface.
 */
export function registerProxies(
  app: Application,
  config: AgorConfig,
  jwtSecret: string,
  opts: RegisterProxiesOptions = {}
): ResolvedProxy[] {
  const proxies = resolveProxies(config);
  if (proxies.length === 0) return [];

  const byVendor = new Map<string, ResolvedProxy>();
  for (const p of proxies) byVendor.set(p.vendor, p);

  const limit = opts.rateLimitPerMinute ?? RATE_LIMIT_PER_MINUTE;

  // Per-(user, vendor) rate limit. The keyGenerator runs after auth, so
  // `req.user` is populated. We bucket by user_id (not IP) because every
  // request is authenticated and the user identity is the meaningful
  // throttle dimension.
  const limiter =
    limit > 0
      ? rateLimit({
          windowMs: 60_000,
          limit,
          standardHeaders: 'draft-7',
          legacyHeaders: false,
          keyGenerator: (req: Request): string => {
            const user = (req as Request & { _agorUser?: AuthedUser })._agorUser;
            const vendor = (req as Request & { _agorVendor?: string })._agorVendor ?? 'unknown';
            return `${user?.user_id ?? req.ip}|${vendor}`;
          },
          message: { error: 'rate_limited' },
        })
      : null;

  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Path tail (relative to the `/proxies` mount): e.g. `/shortcut/api/v3/projects?x=1`.
    // Express 5 strips the mount path from `req.url`. The first segment is
    // the vendor slug.
    const url = req.url;
    const slashIdx = url.indexOf('/', 1);
    const vendor = slashIdx === -1 ? url.slice(1).split('?')[0] : url.slice(1, slashIdx);
    const tail = slashIdx === -1 ? '' : url.slice(slashIdx);

    // Authenticate first — keeps the proxy from leaking vendor existence
    // to anonymous probes and matches the brief's "mount with requireAuth"
    // contract. The proxy is never an open relay regardless of vendor
    // dispatch ordering.
    const user = authenticateRequest(req, jwtSecret);
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (!vendor) {
      res.status(404).json({ error: 'unknown_vendor', vendor: '' });
      return;
    }

    const proxy = byVendor.get(vendor);
    if (!proxy) {
      res.status(404).json({ error: 'unknown_vendor', vendor });
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    if (!proxy.allowed_methods.includes(method as ResolvedProxy['allowed_methods'][number])) {
      res.setHeader('Allow', proxy.allowed_methods.join(', '));
      res.status(405).json({ error: 'method_not_allowed', method, allowed: proxy.allowed_methods });
      return;
    }

    (req as Request & { _agorUser?: AuthedUser })._agorUser = user;
    (req as Request & { _agorVendor?: string })._agorVendor = vendor;

    if (limiter) {
      // express-rate-limit is itself middleware; invoke it in-line and let
      // it short-circuit the response if the bucket is empty.
      let limited = false;
      await new Promise<void>((resolve) => {
        limiter(req, res, (err?: unknown) => {
          if (err) limited = true;
          resolve();
        });
      });
      if (limited || res.headersSent) return;
    }

    // Up-front Content-Length guard for the request body (cheap; saves us
    // streaming a giant POST only to truncate it). We don't enforce on
    // GET/HEAD which carry no body anyway.
    const declaredLen = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
      res.status(413).json({ error: 'request_too_large' });
      return;
    }

    // Sanitize request headers.
    const upstreamHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (REQUEST_HEADER_STRIP.has(lower)) continue;
      if (Array.isArray(value)) {
        upstreamHeaders[lower] = value.join(', ');
      } else if (typeof value === 'string') {
        upstreamHeaders[lower] = value;
      }
    }

    const hasBody = method !== 'GET' && method !== 'HEAD';
    const upstreamUrl = buildUpstreamUrl(proxy.upstream, tail);

    // The daemon mounts `express.json()` and `express.urlencoded()` BEFORE
    // registerRoutes runs (see apps/agor-daemon/src/index.ts:388-389), so
    // by the time we get here `req.body` may already be a parsed object,
    // a Buffer (from a raw parser elsewhere), a string, or `undefined`.
    // Re-serialize it so the upstream sees bytes that match the caller's
    // intent. The "pass-through bytes only" rule is best-effort: any JSON
    // body has already been re-encoded once by express.json, so the bytes
    // we send may differ in whitespace from what the artifact wrote — but
    // semantic content is preserved.
    let outboundBody: string | Buffer | undefined;
    if (hasBody) {
      const parsed = (req as Request & { body?: unknown }).body;
      if (parsed instanceof Buffer) {
        outboundBody = parsed;
      } else if (typeof parsed === 'string') {
        outboundBody = parsed;
      } else if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        outboundBody = JSON.stringify(parsed);
        if (!upstreamHeaders['content-type']) {
          upstreamHeaders['content-type'] = 'application/json';
        }
      }
      // No body / empty parsed object → leave outboundBody undefined.
    }

    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method,
        headers: upstreamHeaders,
        body: outboundBody,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      // Don't echo the upstream error message to the caller — avoids
      // leaking internal details (resolved IP, hostname, library tracebacks).
      console.warn(`[proxies] ${vendor} upstream error:`, err);
      res.status(502).json({ error: 'upstream_error' });
      return;
    }

    // Reject up-front oversize responses cheaply via Content-Length.
    const upstreamLen = Number(upstreamRes.headers.get('content-length') ?? '0');
    if (Number.isFinite(upstreamLen) && upstreamLen > MAX_RESPONSE_BYTES) {
      try {
        await upstreamRes.body?.cancel();
      } catch {
        // ignore
      }
      res.status(502).json({ error: 'upstream_too_large' });
      return;
    }

    // Forward status + sanitized headers.
    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((value, name) => {
      if (RESPONSE_HEADER_STRIP.has(name.toLowerCase())) return;
      res.setHeader(name, value);
    });

    const ok = await relayBody(upstreamRes, res);
    if (!ok && !res.headersSent) {
      // We already started writing the body (headers were sent above) so
      // the only signal we can give the caller about truncation is to
      // leave the connection broken. If headers haven't gone yet because
      // the cap was hit on the first chunk, surface a 502.
      res.status(502).json({ error: 'upstream_too_large' });
    } else if (!ok) {
      // Headers were sent and we hit the cap mid-stream; the caller will
      // see a truncated body. Logging here so operators can spot vendors
      // that consistently exceed the cap.
      console.warn(`[proxies] ${vendor} response exceeded ${MAX_RESPONSE_BYTES} bytes; truncated`);
      res.end();
    }
    // `next` is intentionally unused — the middleware terminates the request.
    void next;
  };

  // FeathersJS app.use is overloaded: a service when given a service object,
  // raw Express middleware otherwise. Cast to `any` to disambiguate, the
  // same pattern used at register-routes.ts:325 for the auth rate limiter.
  // biome-ignore lint/suspicious/noExplicitAny: Feathers Application vs Express middleware overload
  (app as any).use('/proxies', handler);

  console.log(
    `🔁 HTTP proxies enabled: ${proxies
      .map((p) => `${p.vendor}→${new URL(p.upstream).origin}`)
      .join(', ')}`
  );

  return proxies;
}
