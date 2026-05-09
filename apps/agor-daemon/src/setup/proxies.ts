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
 *   5. No auth injection — daemon does not set vendor auth headers on
 *      forwarded requests. Auth stays in the artifact: declare
 *      `agor_grants.agor_token: true` and `requiredEnvVars: [...]` at
 *      publish time and the daemon synthesizes the values into a
 *      per-viewer `.env`.
 */

import type { AgorConfig } from '@agor/core/config';
import { type ResolvedProxy, resolveProxies } from '@agor/core/config';
import type { Application } from '@agor/core/feathers';
import type { UUID } from '@agor/core/types';
import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';

/**
 * Default per-(user, vendor) rate limit. In-memory bucket; no redis.
 *
 * Sized as a "don't take the daemon down" cap, not a workload tuner: at
 * 10 req/s a normal artifact (dashboard with parallel chart loads, polling
 * UI, fan-out fetches) never notices it, while a runaway `while(true) fetch()`
 * loop is held to a level the daemon's event loop and the upstream's quota
 * can both absorb. Hits return HTTP 429 immediately — no queueing — so
 * setting this aggressively low surfaces as broken UI rather than slow UI.
 */
const RATE_LIMIT_PER_MINUTE = 600;

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
 * - `accept-encoding`: Node's undici fetch transparently decompresses gzip/br,
 *   so we always receive raw bytes from upstream regardless of what we ask
 *   for. Forwarding the browser's `accept-encoding: gzip, br` causes upstream
 *   to compress, undici to silently decompress, and us to relay the
 *   decompressed bytes — but the upstream `content-encoding: gzip` header
 *   leaks through to the caller, who then tries to gunzip raw JSON and hangs
 *   the body stream forever. Asking upstream for `identity` sidesteps the
 *   whole double-handling problem.
 */
const REQUEST_HEADER_STRIP = new Set([
  'cookie',
  'host',
  'connection',
  'content-length',
  'accept-encoding',
]);

/**
 * Headers stripped from the upstream response before relaying to the caller.
 *
 * - `set-cookie`: never let upstream set cookies on the daemon's domain.
 * - `transfer-encoding`, `connection`: hop-by-hop.
 * - `content-length`: we may truncate or re-encode and don't want a stale value.
 * - `content-encoding`: defense-in-depth pair to the `accept-encoding` strip
 *   above. Even if upstream ignores `accept-encoding: identity` and sends
 *   compressed bytes, undici has already decompressed them by the time we
 *   read `body` — so the original `content-encoding` value is a lie that
 *   makes browsers fail to decode the relayed body.
 */
const RESPONSE_HEADER_STRIP = new Set([
  'set-cookie',
  'transfer-encoding',
  'connection',
  'content-length',
  'content-encoding',
]);

interface AuthedUser {
  user_id: string;
}

/**
 * Verify the Bearer JWT on the incoming request and load the user entity.
 *
 * Mirrors the WebSocket auth pattern at
 * `apps/agor-daemon/src/setup/socketio.ts:286-329` — verify the token, then
 * fetch the user from `app.service('users')`. Skipping the user load (i.e.
 * trusting `decoded.sub` blindly) would let tokens for deleted/disabled users
 * keep working until expiry, which diverges from the rest of the daemon's
 * auth surface and was caught in code review.
 *
 * Service tokens are explicitly rejected — the proxy exists to serve
 * browser-side artifacts, not the executor process.
 */
async function authenticateRequest(
  req: Request,
  app: Application,
  jwtSecret: string
): Promise<AuthedUser | null> {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  let decoded: { sub?: string; type?: string };
  try {
    decoded = jwt.verify(match[1], jwtSecret, {
      issuer: 'agor',
      audience: 'https://agor.dev',
    }) as { sub?: string; type?: string };
  } catch {
    return null;
  }
  // Reject service tokens; only end-user access tokens are accepted here.
  if (decoded.type !== undefined && decoded.type !== 'access') return null;
  if (!decoded.sub) return null;
  try {
    const user = await app.service('users').get(decoded.sub as UUID);
    if (!user) return null;
    return { user_id: decoded.sub };
  } catch {
    // User not found / lookup error → reject the request.
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
    // Express strips the mount path from `req.url`. Split the pathname from
    // the querystring up-front so a root-vendor request like
    // `/proxies/shortcut?foo=1` correctly forwards `?foo=1` (the previous
    // string-slicing approach dropped it; caught in code review).
    const url = req.url;
    const qIdx = url.indexOf('?');
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    const search = qIdx === -1 ? '' : url.slice(qIdx);
    const slashIdx = pathname.indexOf('/', 1);
    const vendor = slashIdx === -1 ? pathname.slice(1) : pathname.slice(1, slashIdx);
    const tailPath = slashIdx === -1 ? '' : pathname.slice(slashIdx);
    const tail = `${tailPath}${search}`;

    // Authenticate first — keeps the proxy from leaking vendor existence
    // to anonymous probes and matches the brief's "mount with requireAuth"
    // contract. The proxy is never an open relay regardless of vendor
    // dispatch ordering.
    const user = await authenticateRequest(req, app, jwtSecret);
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
    // Force `identity` so upstream sends uncompressed bytes. undici defaults
    // to `gzip, br` if not specified, and silently decompresses — leaving us
    // serving raw bytes under a stale `content-encoding: gzip` header that
    // hangs the browser's body decoder. See the comment on REQUEST_HEADER_STRIP.
    upstreamHeaders['accept-encoding'] = 'identity';

    const hasBody = method !== 'GET' && method !== 'HEAD';
    const upstreamUrl = buildUpstreamUrl(proxy.upstream, tail);

    // The proxy mount is wired BEFORE `express.json()` / `express.urlencoded()`
    // (see apps/agor-daemon/src/index.ts) by attaching `express.raw()` to
    // `/proxies`, so `req.body` is always a Buffer (or empty) here. This is
    // what the "pass-through bytes only" rule requires: the upstream sees
    // exactly the bytes the artifact wrote, with no JSON / form re-encoding
    // happening in between.
    let outboundBody: Buffer | undefined;
    if (hasBody) {
      const parsed = (req as Request & { body?: unknown }).body;
      if (parsed instanceof Buffer && parsed.byteLength > 0) {
        outboundBody = parsed;
      }
      // No body / empty Buffer → leave outboundBody undefined.
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
