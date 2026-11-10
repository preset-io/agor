// Standalone process entry point for the cassette proxy — run as its own
// subprocess (not an in-process object) for the same reason the daemon and
// UI are: Playwright's globalSetup and globalTeardown are not guaranteed to
// run in the same Node process, so an in-memory closure (the recorded
// interactions, the open http.Server) would not survive from setup to
// teardown. A subprocess tracked by PID (see harness.ts) does.
//
// Env in: AGOR_E2E_AGENT_MODE ('live' | 'replay'), CASSETTE_PATH,
// UPSTREAM_HOST, PROXY_PORT.

import { startCassetteProxy } from './cassette-proxy.ts';

const mode = process.env.AGOR_E2E_AGENT_MODE === 'live' ? 'live' : 'replay';
const cassettePath = process.env.CASSETTE_PATH;
if (!cassettePath) throw new Error('cassette-proxy-cli: CASSETTE_PATH env var is required');

const handle = await startCassetteProxy({
  mode,
  append: process.env.AGOR_E2E_CASSETTE_APPEND === '1',
  cassettePath,
  upstreamHost: process.env.UPSTREAM_HOST ?? 'api.anthropic.com',
  port: process.env.PROXY_PORT ? Number(process.env.PROXY_PORT) : undefined,
});

console.log(
  `[cassette-proxy] listening on :${handle.port} (mode=${mode}, cassette=${cassettePath})`
);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await handle.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
