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
// This is deliberately NOT wired into every E2E spec — only ones that
// actually invoke a real agent turn opt in, via AGOR_E2E_AGENT_MODE.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
}

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
}): Promise<CassetteProxyHandle> {
  const { mode, cassettePath, upstreamHost } = options;

  const recorded: CassetteEntry[] = [];
  const replayCassette = mode === 'replay' ? loadCassette(cassettePath) : null;
  if (mode === 'replay' && (!replayCassette || replayCassette.entries.length === 0)) {
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

  const server = createServer(async (req, res) => {
    // Harness readiness probe — never touches replay index or upstream.
    if (req.url === '/__cassette_health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    const bodyBuf = await readBody(req);

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
      for (const chunkB64 of entry.responseChunksBase64) {
        res.write(Buffer.from(chunkB64, 'base64'));
      }
      res.end();
      return;
    }

    // live: forward to the real upstream, stream back, record as we go.
    const upstreamReq = httpsRequest(
      {
        hostname: upstreamHost,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstreamHost },
      },
      (upstreamRes) => {
        const responseChunks: Buffer[] = [];
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.on('data', (chunk: Buffer) => {
          responseChunks.push(chunk);
          res.write(chunk);
        });
        upstreamRes.on('end', () => {
          res.end();
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
          });
        });
      }
    );
    upstreamReq.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`cassette-proxy: upstream error: ${err.message}`);
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
          writeFileSync(
            cassettePath,
            JSON.stringify({ upstreamHost, entries: recorded } satisfies Cassette, null, 2)
          );
          console.log(
            `[cassette-proxy] recorded ${recorded.length} interaction(s) → ${cassettePath}`
          );
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
