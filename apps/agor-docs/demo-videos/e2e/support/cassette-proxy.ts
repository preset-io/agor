// Record/replay HTTP proxy for a real agent's outbound API traffic (Claude
// Code's Anthropic calls today; the same shape works for any provider that
// honors a base-URL override). Sits between the executor and the real
// provider API via ANTHROPIC_BASE_URL (the Claude Agent SDK — and Claude
// Code CLI — both honor this env var for proxy/enterprise setups).
//
// 'live' mode: forwards every request to the real upstream, streams the
// response back to the caller untouched, and records the full interaction
// (method, path, headers, request body, response status/headers, and the
// exact sequence of response byte chunks — preserving SSE streaming shape)
// to a JSON cassette file.
//
// 'replay' mode: touches the network for nothing. Requests are matched by
// (method + path) — each such bucket serves its recorded responses in order,
// then repeats its LAST recorded response for any further requests. Never by
// content hash (request bodies carry incidental nondeterminism — timestamps,
// tool-call IDs) and never globally sequential: the daemon's check-auth
// probe (GET /v1/models) and the CLI's periodic count_tokens calls fire a
// run-dependent number of times, interleaved unpredictably with the
// /v1/messages calls, so a strict global sequence would misalign. Only a
// path with no recording at all is an error (599).
//
// 'hold' (either mode, toggled at runtime with POST /__cassette_hold?on=1|0):
// requests for model turns (POST /v1/messages) are parked and never answered
// or recorded, so agents started while it's on stay "running" for as long as
// a take needs. How a clip shows several sessions working at once: replay
// matches by path, so concurrent turns can't replay faithfully, and a held
// turn needs no recording at all. Parked requests close with the proxy.
//
// This is deliberately NOT wired into every E2E spec — only ones that
// actually invoke a real agent turn opt in, via AGOR_E2E_AGENT_MODE.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type AgentMode = 'live' | 'replay';

interface CassetteEntry {
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBodyBase64: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  /** Response body chunks in original arrival order, base64-encoded — preserves SSE framing. */
  responseChunksBase64: string[];
  /**
   * When each chunk arrived, in ms after the request was sent. Replay waits
   * the same way so a recorded answer streams onto the screen at its
   * original pace (AGOR_E2E_REPLAY_SPEED scales it; cassettes recorded
   * before this field existed replay instantly).
   */
  responseChunkOffsetsMs?: number[];
}

/**
 * Seeded demo accounts store a placeholder credential (see Seeder.connectAi),
 * so no real token ever lands in the scratch database or its checkpoints. In
 * live mode the proxy swaps the placeholder for the real token it was started
 * with (AGOR_E2E_REAL_AUTH_TOKEN, from .e2e-secrets) on the way upstream.
 */
export const PLACEHOLDER_TOKEN = 'sk-ant-oat01-replay-placeholder';
const REAL_TOKEN = process.env.AGOR_E2E_REAL_AUTH_TOKEN ?? '';

function withRealCredential(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[] | undefined> {
  if (!REAL_TOKEN) return headers;
  const out = { ...headers };
  for (const key of ['authorization', 'x-api-key']) {
    const v = out[key];
    if (typeof v === 'string' && v.includes(PLACEHOLDER_TOKEN)) {
      out[key] = v.replace(PLACEHOLDER_TOKEN, REAL_TOKEN);
    }
  }
  return out;
}

const REPLAY_SPEED = Number(process.env.AGOR_E2E_REPLAY_SPEED ?? 1) || 1;
/**
 * Snappy replays: cap the wait before a response's first chunk (the model's
 * time to first token) at this many ms. The rest of the stream keeps its
 * recorded rhythm, scaled by REPLAY_SPEED.
 */
const REPLAY_FIRST_CHUNK_MS = process.env.AGOR_E2E_REPLAY_FIRST_CHUNK_MS
  ? Number(process.env.AGOR_E2E_REPLAY_FIRST_CHUNK_MS)
  : null;

interface Cassette {
  upstreamHost: string;
  entries: CassetteEntry[];
}

// Headers that only make sense for the original hop and must never be
// blindly replayed (framing headers Node's http server recomputes itself,
// or a per-connection header a synthetic replay socket can't honor).
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'transfer-encoding',
  'content-length',
  'keep-alive',
]);

// Cassettes are meant to be committed (that's the whole point of replay
// mode — no live credentials needed to run the suite) — never let the real
// bearer credential land in a file on disk.
const REDACT_REQUEST_HEADERS = new Set(['authorization', 'x-api-key']);
const REDACTED = '[redacted-by-cassette-proxy]';

function redactRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT_REQUEST_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function loadCassette(path: string): Cassette {
  if (!existsSync(path)) return { upstreamHost: '', entries: [] };
  return JSON.parse(readFileSync(path, 'utf-8')) as Cassette;
}

export interface CassetteProxyHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startCassetteProxy(options: {
  mode: AgentMode;
  cassettePath: string;
  upstreamHost: string; // e.g. 'api.anthropic.com'
  port?: number;
  append?: boolean;
  /** Start in hold mode (see above); a missing cassette is then fine. */
  hold?: boolean;
}): Promise<CassetteProxyHandle> {
  const { mode, cassettePath, upstreamHost } = options;

  const recorded: CassetteEntry[] = [];
  // Append mode: a live run adds onto the existing cassette instead of
  // replacing it — how the suite records in chunks (later lessons against
  // a kept workspace) without re-burning earlier lessons' metered turns.
  if (mode === 'live' && options.append && existsSync(cassettePath)) {
    const prior = loadCassette(cassettePath);
    recorded.push(...prior.entries);
    console.log(`[cassette-proxy] append mode: preloaded ${prior.entries.length} entries`);
  }
  const replayCassette = mode === 'replay' ? loadCassette(cassettePath) : null;
  if (
    mode === 'replay' &&
    !options.hold &&
    (!replayCassette || replayCassette.entries.length === 0)
  ) {
    throw new Error(
      `cassette-proxy: replay mode requested but no recorded cassette found at ${cassettePath}. ` +
        'Run with AGOR_E2E_AGENT_MODE=live first to record one.'
    );
  }
  // Per-(method + path) queues, in recorded order; `replayLastServed` keeps
  // each bucket's most recent entry so an exhausted bucket repeats it.
  const replayBuckets = new Map<string, CassetteEntry[]>();
  const replayLastServed = new Map<string, CassetteEntry>();
  for (const entry of replayCassette?.entries ?? []) {
    const key = `${entry.method} ${entry.path}`;
    const bucket = replayBuckets.get(key);
    if (bucket) bucket.push(entry);
    else replayBuckets.set(key, [entry]);
  }

  let holding = options.hold ?? false;
  const parked = new Set<import('node:http').ServerResponse>();

  const server = createServer(async (req, res) => {
    // Harness readiness probe — never touches replay index or upstream.
    if (req.url === '/__cassette_health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url?.startsWith('/__cassette_hold')) {
      holding = new URL(req.url, 'http://proxy').searchParams.get('on') === '1';
      console.log(`[cassette-proxy] hold ${holding ? 'on' : 'off'}`);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(holding ? 'holding' : 'released');
      return;
    }

    const bodyBuf = await readBody(req);

    if (holding && req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":1000}');
        return;
      }
      parked.add(res);
      res.on('close', () => parked.delete(res));
      return;
    }

    if (mode === 'replay') {
      const key = `${req.method} ${req.url}`;
      let entry = replayBuckets.get(key)?.shift();
      if (entry) {
        replayLastServed.set(key, entry);
      } else {
        entry = replayLastServed.get(key);
        if (entry) {
          console.warn(`[cassette-proxy] bucket exhausted, repeating last response: ${key}`);
        }
      }
      if (!entry && holding) {
        // Holding with nothing recorded: answer side calls (the auth probe's
        // model list) blandly so nothing on camera reports an error.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[],"has_more":false}');
        return;
      }
      if (!entry) {
        console.error(`[cassette-proxy] no recording for: ${key}`);
        res.writeHead(599, { 'content-type': 'text/plain' });
        res.end(`cassette-proxy: no recorded entry for ${key}`);
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry.responseHeaders)) {
        if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) headers[k] = v;
      }
      res.writeHead(entry.responseStatus, headers);
      const replayStart = Date.now();
      for (const [i, chunkB64] of entry.responseChunksBase64.entries()) {
        const offsets = entry.responseChunkOffsetsMs;
        const first = offsets?.[0] ?? 0;
        const lead =
          REPLAY_FIRST_CHUNK_MS === null
            ? first / REPLAY_SPEED
            : Math.min(first, REPLAY_FIRST_CHUNK_MS);
        const due = lead + ((offsets?.[i] ?? 0) - first) / REPLAY_SPEED;
        const wait = replayStart + due - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (res.destroyed) return;
        res.write(Buffer.from(chunkB64, 'base64'));
      }
      res.end();
      return;
    }

    // live: forward to the real upstream, stream back, record as we go.
    const t0 = Date.now();
    let clientClosedEarly = false;
    res.on('close', () => {
      if (!res.writableEnded) clientClosedEarly = true;
    });
    const upstreamReq = httpsRequest(
      {
        hostname: upstreamHost,
        path: req.url,
        method: req.method,
        headers: withRealCredential({ ...req.headers, host: upstreamHost }),
      },
      (upstreamRes) => {
        const responseChunks: Buffer[] = [];
        const chunkOffsets: number[] = [];
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.on('data', (chunk: Buffer) => {
          responseChunks.push(chunk);
          chunkOffsets.push(Date.now() - t0);
          res.write(chunk);
        });
        upstreamRes.on('end', () => {
          res.end();
          console.log(
            `[cassette-proxy] ${req.method} ${req.url} -> ${upstreamRes.statusCode} ` +
              `${Date.now() - t0}ms req=${bodyBuf.length}B resp=${responseChunks.reduce((n, c) => n + c.length, 0)}B` +
              `${clientClosedEarly ? ' CLIENT_ABORTED' : ''}`
          );
          const reqHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') reqHeaders[k] = v;
          }
          recorded.push({
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            requestHeaders: redactRequestHeaders(reqHeaders),
            requestBodyBase64: bodyBuf.toString('base64'),
            responseStatus: upstreamRes.statusCode ?? 0,
            responseHeaders: headers,
            responseChunksBase64: responseChunks.map((c) => c.toString('base64')),
            responseChunkOffsetsMs: chunkOffsets,
          });
        });
      }
    );
    // A dropped network (or a sleeping laptop) can leave an upstream request
    // hanging for many minutes before the socket errors. Give up after 90s of
    // silence instead, so the agent's own retry kicks in promptly. Streaming
    // responses send keep-alive pings far more often than that.
    upstreamReq.setTimeout(90_000, () => {
      upstreamReq.destroy(new Error('no data from upstream for 90s'));
    });
    upstreamReq.on('error', (err) => {
      console.log(
        `[cassette-proxy] ${req.method} ${req.url} -> UPSTREAM_ERROR ${Date.now() - t0}ms ` +
          `req=${bodyBuf.length}B err=${err.message}${clientClosedEarly ? ' CLIENT_ABORTED' : ''}`
      );
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end(`cassette-proxy: upstream error: ${err.message}`);
    });
    // A client that aborts (speculative requests are normal for the CLI)
    // must tear down its upstream leg rather than leak it.
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });
    if (bodyBuf.length > 0) upstreamReq.write(bodyBuf);
    upstreamReq.end();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (mode === 'live') {
          // Atomic write: a run killed mid-write must never leave a
          // truncated cassette behind (replay crashes parsing it).
          const tmpPath = `${cassettePath}.tmp`;
          writeFileSync(
            tmpPath,
            JSON.stringify({ upstreamHost, entries: recorded } satisfies Cassette, null, 2)
          );
          renameSync(tmpPath, cassettePath);
          console.log(
            `[cassette-proxy] recorded ${recorded.length} interaction(s) → ${cassettePath}`
          );
        }
        for (const res of parked) res.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
