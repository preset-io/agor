#!/usr/bin/env node
// Slow-network UI benchmark: boots one scratch daemon per build against a copy
// of the seeded database, puts a TCP link emulator in front of it, and drives
// Chromium through cold `/s/<id>` and board opens. See ./README.md.
//
//   node scripts/perf-slow-network/run-bench.mjs \
//     --target main=/tmp/agor-bench-main --target pr=/tmp/agor-bench-pr \
//     --seed-home /tmp/agor-bench-seed-home --reps 3 --out /tmp/bench.json

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startThrottleProxy } from './throttle-proxy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
// Playwright is a devDependency of the UI package.
const { chromium } = createRequire(path.join(repoRoot, 'apps/agor-ui/package.json'))('playwright');

const PROFILES = {
  // ~150 ms RTT, 5 Mbps down / 2 Mbps up: a typical corporate VPN.
  vpn: { rttMs: 150, downMbps: 5, upMbps: 2 },
  // Harsher: 300 ms RTT, 1.5 Mbps down / 0.75 Mbps up.
  harsh: { rttMs: 300, downMbps: 1.5, upMbps: 0.75 },
  // No shaping (sanity check for CPU-side costs).
  none: { rttMs: 0, downMbps: 10_000, upMbps: 10_000 },
};

function parseArgs(argv) {
  const out = {
    targets: [],
    reps: 3,
    profiles: ['vpn', 'harsh'],
    scenarios: ['session', 'board'],
    cache: ['cold', 'warm'],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--target') {
      const [name, dir] = next().split('=');
      out.targets.push({ name, dir: path.resolve(dir) });
    } else if (a === '--seed-home') out.seedHome = path.resolve(next());
    else if (a === '--reps') out.reps = Number(next());
    else if (a === '--profiles') out.profiles = next().split(',');
    else if (a === '--scenarios') out.scenarios = next().split(',');
    else if (a === '--cache') out.cache = next().split(',');
    else if (a === '--out') out.out = path.resolve(next());
    else if (a === '--base-port') out.basePort = Number(next());
    else if (a === '--screenshots') out.screenshots = path.resolve(next());
    else if (a === '--headed') out.headed = true;
    else if (a === '--trace') out.trace = true;
    else if (a === '--perf-trace') out.perfTrace = path.resolve(next());
    else throw new Error(`unknown arg ${a}`);
  }
  if (!out.targets.length) throw new Error('at least one --target name=worktreeDir is required');
  if (!out.seedHome) throw new Error('--seed-home is required');
  out.basePort ??= 4420;
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnvFile(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^export ([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function startDaemon(target, port, seedHome) {
  const home = `/tmp/agor-bench-run/${target.name}`;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(path.join(home, '.agor'), { recursive: true });
  copyFileSync(path.join(seedHome, 'pristine.db'), path.join(home, '.agor/agor.db'));
  const config = readFileSync(path.join(seedHome, '.agor/config.yaml'), 'utf8').replace(
    /port: \d+/g,
    `port: ${port}`
  );
  writeFileSync(path.join(home, '.agor/config.yaml'), config);
  // The daemon serves `dist/../ui` when present (the packaged layout).
  const uiLink = path.join(target.dir, 'apps/agor-daemon/ui');
  const createdUiLink = !existsSync(uiLink);
  if (createdUiLink) symlinkSync(path.join(target.dir, 'apps/agor-ui/dist'), uiLink);

  const seedEnv = readEnvFile(path.join(seedHome, 'env.sh'));
  const env = {
    ...process.env,
    HOME: home,
    NODE_ENV: 'production',
    PORT: String(port),
    AGOR_JWT_SECRET: seedEnv.AGOR_JWT_SECRET,
    AGOR_MASTER_SECRET: seedEnv.AGOR_MASTER_SECRET,
  };
  delete env.AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN;
  delete env.AGOR_ADMIN_PASSWORD;
  const { openSync } = await import('node:fs');
  const log = openSync(path.join(home, 'daemon.log'), 'w');
  const child = spawn(process.execPath, ['apps/agor-daemon/dist/main.js'], {
    cwd: target.dir,
    env,
    stdio: ['ignore', log, log],
  });
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        const health = await res.json();
        return { child, home, health, uiLink: createdUiLink ? uiLink : null };
      }
    } catch {}
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  child.kill('SIGKILL');
  throw new Error(`daemon for ${target.name} did not become healthy (see ${home}/daemon.log)`);
}

async function login(port, email) {
  const res = await fetch(`http://localhost:${port}/authentication`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'local', email, password: 'admin' }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Installed before any page script: long-task observer and text watchers that
// record (in page time, ms since navigation start) when each target first
// appears in the DOM.
const initScript = ({ tokens, watch }) => {
  window.AGOR_DAEMON_URL = window.location.origin;
  localStorage.setItem('agor-access-token', tokens.accessToken);
  if (tokens.refreshToken) localStorage.setItem('agor-refresh-token', tokens.refreshToken);
  const bench = { marks: {}, longTasks: [] };
  window.__bench = bench;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) bench.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  let scheduled = false;
  let pendingCover = false;
  const check = () => {
    scheduled = false;
    pendingCover = false;
    const root = document.body;
    if (!root) return;
    for (const w of watch) {
      if (bench.marks[w.name] !== undefined) continue;
      const scope = w.selector ? document.querySelector(w.selector) : root;
      if (scope && (!w.text || scope.textContent.includes(w.text))) {
        // Content under a loading overlay isn't visible yet: count it once
        // the overlay is gone or at least half faded.
        const cover = document.querySelector('[data-testid="initial-loading-screen"]');
        if (cover && Number(getComputedStyle(cover).opacity) >= 0.5) {
          pendingCover = true;
          continue;
        }
        bench.marks[w.name] = performance.now();
      }
    }
    // An opacity transition fires no mutations: keep polling per frame.
    if (pendingCover && !scheduled) {
      scheduled = true;
      requestAnimationFrame(check);
    }
  };
  const observer = new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(check);
    }
  });
  const start = () =>
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
};

async function measure({
  perfTrace,
  browser,
  proxy,
  port,
  proxyPort,
  manifest,
  scenario,
  cache,
  tokens,
  screenshot,
  trace,
}) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const base = scenario.replace(/-reconnect$/, '');
  const url =
    base === 'session'
      ? `http://localhost:${proxyPort}/ui/s/${manifest.openSessionId}`
      : `http://localhost:${proxyPort}/ui/b/${manifest.boardSlug}`;
  const watch =
    base === 'session'
      ? [
          {
            name: 'transcript',
            selector: '[data-testid="conversation-scroll-container"]',
            text: manifest.latestPromptSnippet,
          },
          { name: 'board', selector: '.react-flow__node-branchNode' },
        ]
      : [{ name: 'board', selector: '.react-flow__node-branchNode' }];
  await context.addInitScript(initScript, { tokens, watch });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  if (cache === 'warm' || scenario.endsWith('-reconnect')) {
    // Prime the HTTP cache with an untimed load, then measure a reload.
    await page.goto(url, { waitUntil: 'load' });
    await waitForMark(page, watch[0].name, 180_000).catch(async (error) => {
      await page.screenshot({ path: '/tmp/agor-bench-failure.png' }).catch(() => {});
      await context.close();
      throw error;
    });
    await waitForQuiet(proxy, page, 2_000, 60_000);
  }

  const reqs = new Map();
  const counters = {
    httpRequests: 0,
    httpFromCache: 0,
    wsIn: 0,
    wsOut: 0,
    wsInPayload: 0,
    wsOutPayload: 0,
    byType: {},
  };
  const origin = `http://localhost:${proxyPort}`;
  const strays = [];
  const guard = (u) => {
    // Everything must go through the link emulator (and never to another daemon).
    if (
      !u.startsWith(origin) &&
      !u.startsWith(origin.replace('http', 'ws')) &&
      !u.startsWith('data:') &&
      !u.startsWith('blob:') &&
      // index.html's web-font stylesheet; identical in every build and not
      // shaped by the emulator (it is a third-party CDN, not the daemon).
      !u.startsWith('https://fonts.bunny.net/')
    )
      strays.push(u);
  };
  const http = new Map();
  cdp.on('Network.requestWillBeSent', (e) => {
    reqs.set(e.requestId, e.type);
    guard(e.request.url);
    if (trace)
      http.set(e.requestId, {
        url: e.request.url.replace(origin, ''),
        type: e.type,
        startMs: Math.round(e.timestamp * 1000 - navWall),
      });
  });
  cdp.on('Network.loadingFinished', (e) => {
    const h = http.get(e.requestId);
    if (h)
      Object.assign(h, {
        endMs: Math.round(e.timestamp * 1000 - navWall),
        bytes: e.encodedDataLength,
      });
  });
  cdp.on('Network.webSocketCreated', (e) => guard(e.url));
  // Count requests that actually crossed the network (memory/disk cache hits
  // excluded), once each.
  const fromCache = new Set();
  cdp.on('Network.requestServedFromCache', (e) => fromCache.add(e.requestId));
  cdp.on('Network.responseReceived', (e) => {
    if (e.response.fromDiskCache || e.response.fromPrefetchCache || e.response.fromServiceWorker)
      fromCache.add(e.requestId);
  });
  cdp.on('Network.loadingFinished', (e) => {
    if (fromCache.has(e.requestId)) counters.httpFromCache++;
    else counters.httpRequests++;
    const type = reqs.get(e.requestId) ?? 'Other';
    counters.byType[type] = (counters.byType[type] ?? 0) + e.encodedDataLength;
  });
  // Socket.IO request/ack correlation for --trace: `42<id>["find","sessions",…]`
  // out, `43<id>[err, result]` back. Sizes are decompressed payload bytes.
  const calls = new Map();
  const events = {};
  let navWall = 0;
  cdp.on('Network.webSocketFrameReceived', (e) => {
    counters.wsIn++;
    const data = e.response.payloadData;
    counters.wsInPayload += data.length;
    if (!trace) return;
    const ack = /^43(\d+)/.exec(data);
    if (ack && calls.has(ack[1])) {
      const c = calls.get(ack[1]);
      c.doneMs = Math.round(e.timestamp * 1000 - navWall);
      c.bytes = data.length;
    } else {
      const ev = /^42\["([^"]+)"/.exec(data);
      if (ev) {
        events[ev[1]] ??= { count: 0, bytes: 0 };
        events[ev[1]].count++;
        events[ev[1]].bytes += data.length;
      }
    }
  });
  cdp.on('Network.webSocketFrameSent', (e) => {
    counters.wsOut++;
    const data = e.response.payloadData;
    counters.wsOutPayload += data.length;
    if (!trace) return;
    const m = /^42(\d+)(\[.*)$/s.exec(data);
    if (!m) return;
    try {
      const [method, service, a, b] = JSON.parse(m[2]);
      const query = method === 'find' ? a : method === 'get' ? b : undefined;
      calls.set(m[1], {
        call: `${method} ${service}`,
        query: query ? JSON.stringify(query).slice(0, 160) : undefined,
        sentMs: Math.round(e.timestamp * 1000 - navWall),
      });
    } catch {}
  });

  proxy.reset();
  // CDP timestamps are monotonic seconds; anchor them at navigation start.
  cdp.once('Network.requestWillBeSent', (e) => {
    navWall = e.timestamp * 1000;
  });
  if (perfTrace) await browser.startTracing(page, { path: perfTrace, screenshots: true });
  const primary = watch[0].name;
  let reconnectStart = 0;
  if (scenario.endsWith('-reconnect')) {
    // Already loaded and quiet (above): drop the link and measure the resync.
    reconnectStart = await page.evaluate(() => performance.now());
    proxy.dropAll();
  } else {
    await page.goto(url, { waitUntil: 'commit' });
    try {
      await waitForMark(page, primary, 180_000);
    } catch (error) {
      await page.screenshot({ path: '/tmp/agor-bench-failure.png' }).catch(() => {});
      await context.close();
      throw error;
    }
  }
  const settledEpoch = await waitForQuiet(proxy, page, 3_000, 120_000);
  if (perfTrace) await browser.stopTracing();
  const pageState = await page.evaluate(() => ({
    marks: window.__bench.marks,
    longTasks: window.__bench.longTasks,
    timeOrigin: performance.timeOrigin,
    nav: performance.getEntriesByType('navigation')[0]?.toJSON(),
  }));
  if (screenshot) await page.screenshot({ path: screenshot });
  const stats = proxy.stats();
  await context.close();
  if (strays.length)
    throw new Error(`requests bypassed the link emulator: ${strays.slice(0, 5).join(', ')}`);
  if (stats.bytesDown === 0) throw new Error('no bytes crossed the link emulator');

  const settledMs = settledEpoch - pageState.timeOrigin - reconnectStart;
  const paintMs = reconnectStart ? 0 : pageState.marks[primary];
  const longTasks = pageState.longTasks.filter(
    ([start]) => start >= reconnectStart && start <= reconnectStart + settledMs + 1
  );
  const lastLongTaskEnd = longTasks.reduce((m, [s, d]) => Math.max(m, s + d), 0);
  return {
    paintMs: Math.round(paintMs),
    boardPaintMs: pageState.marks.board !== undefined ? Math.round(pageState.marks.board) : null,
    // Interactive: the target is painted and the main thread has had its last
    // long task of the load (network may still be trickling in).
    ttiMs: Math.round(Math.max(paintMs, lastLongTaskEnd - reconnectStart)),
    // Settled: last byte of the load crossed the link (followed by 3 s quiet).
    settledMs: Math.round(settledMs),
    domContentLoadedMs: Math.round(pageState.nav?.domContentLoadedEventEnd ?? 0),
    bytesDown: stats.bytesDown,
    bytesUp: stats.bytesUp,
    tcpConnections: stats.connections,
    httpRequests: counters.httpRequests,
    httpFromCache: counters.httpFromCache,
    scriptBytes: counters.byType.Script ?? 0,
    wsFramesIn: counters.wsIn,
    wsFramesOut: counters.wsOut,
    wsPayloadIn: counters.wsInPayload,
    longTaskCount: longTasks.length,
    longTaskTotalMs: Math.round(longTasks.reduce((s, [, d]) => s + d, 0)),
    totalBlockingMs: Math.round(longTasks.reduce((s, [, d]) => s + Math.max(0, d - 50), 0)),
    ...(trace
      ? {
          trace: {
            calls: [...calls.values()].sort((x, y) => x.sentMs - y.sentMs),
            events,
            http: [...http.values()],
            longTasks: longTasks.map(([a, d]) => [Math.round(a), Math.round(d)]),
            marks: pageState.marks,
          },
        }
      : {}),
  };
}

async function waitForMark(page, name, timeoutMs) {
  await page.waitForFunction((n) => window.__bench?.marks?.[n] !== undefined, name, {
    timeout: timeoutMs,
    polling: 100,
  });
}

// Resolves with the epoch time of the last link activity once the link and
// the main thread have both been quiet for `quietMs`.
async function waitForQuiet(proxy, page, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const toEpoch = (t) => performance.timeOrigin + t;
  while (Date.now() < deadline) {
    const last = toEpoch(proxy.stats().lastActivity);
    const lastLong = await page.evaluate(() => {
      const lt = window.__bench?.longTasks ?? [];
      const end = lt.reduce((m, [s, d]) => Math.max(m, s + d), 0);
      return end ? performance.timeOrigin + end : 0;
    });
    const busy = Math.max(last, lastLong);
    if (Date.now() - busy >= quietMs) return last;
    await sleep(200);
  }
  return toEpoch(proxy.stats().lastActivity);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const opts = parseArgs(process.argv);
  const manifest = JSON.parse(
    readFileSync(path.join(opts.seedHome, 'bench-manifest.json'), 'utf8')
  );
  const results = { manifest, profiles: PROFILES, runs: [] };
  const browser = await chromium.launch({ headless: !opts.headed });
  try {
    for (const [ti, target] of opts.targets.entries()) {
      const port = opts.basePort + ti * 2;
      const proxyPort = port + 1;
      console.log(`\n=== ${target.name} (${target.dir}) daemon :${port} proxy :${proxyPort}`);
      const daemon = await startDaemon(target, port, opts.seedHome);
      console.log(`    build ${daemon.health.buildSha ?? '?'}`);
      try {
        for (const profileName of opts.profiles) {
          const profile = PROFILES[profileName];
          const proxy = await startThrottleProxy({
            listenPort: proxyPort,
            targetPort: port,
            ...profile,
          });
          try {
            for (const scenario of opts.scenarios) {
              for (const cache of opts.cache) {
                const samples = [];
                for (let r = 0; r < opts.reps; r++) {
                  const tokens = await login(port, manifest.adminEmail);
                  const screenshot = opts.screenshots
                    ? path.join(
                        opts.screenshots,
                        `${target.name}-${profileName}-${scenario}-${cache}-${r}.png`
                      )
                    : undefined;
                  if (screenshot) mkdirSync(opts.screenshots, { recursive: true });
                  let m;
                  try {
                    m = await measure({
                      browser,
                      proxy,
                      port,
                      proxyPort,
                      manifest,
                      scenario,
                      cache,
                      tokens,
                      screenshot,
                      trace: opts.trace,
                      perfTrace: opts.perfTrace
                        ? opts.perfTrace.replace(
                            /(\.json)?$/,
                            `-${target.name}-${profileName}-${scenario}-${cache}-${r}.json`
                          )
                        : undefined,
                    });
                  } catch (error) {
                    // A load that never paints (e.g. a stalled transcript) is a
                    // result too: record it, exclude it from medians, go on.
                    console.log(
                      `    ${profileName} ${scenario} ${cache} #${r}: FAILED (${error.message.split('\n')[0]})`
                    );
                    samples.push({ failed: true, error: String(error.message).slice(0, 300) });
                    continue;
                  }
                  samples.push(m);
                  console.log(
                    `    ${profileName} ${scenario} ${cache} #${r}: paint ${m.paintMs} ms, tti ${m.ttiMs} ms, settled ${m.settledMs} ms, ` +
                      `down ${(m.bytesDown / 1024).toFixed(0)} KiB, http ${m.httpRequests}, ws ${m.wsFramesIn}/${m.wsFramesOut}, ` +
                      `long ${m.longTaskCount} (${m.longTaskTotalMs} ms)`
                  );
                }
                const ok = samples.filter((sample) => !sample.failed);
                const summary = { failedRuns: samples.length - ok.length };
                for (const k of Object.keys(ok[0] ?? {}).filter((k) => k !== 'trace')) {
                  const vals = ok.map((s) => s[k]).filter((v) => typeof v === 'number');
                  if (vals.length) summary[k] = median(vals);
                }
                results.runs.push({
                  target: target.name,
                  profile: profileName,
                  scenario,
                  cache,
                  median: summary,
                  samples,
                });
              }
            }
          } finally {
            await proxy.close();
          }
        }
      } finally {
        daemon.child.kill('SIGTERM');
        await sleep(1000);
        if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
        if (daemon.uiLink) rmSync(daemon.uiLink, { force: true });
      }
    }
  } finally {
    await browser.close();
  }
  if (opts.out) {
    writeFileSync(opts.out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nwrote ${opts.out}`);
  }
  printTable(results);
}

function printTable(results) {
  const kib = (b) => `${(b / 1024).toFixed(0)} KiB`;
  const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
  console.log(
    '\n| Profile | Scenario | Cache | Build | Paint | TTI | Settled | Down | HTTP | WS in/out | Long tasks (ms) |'
  );
  console.log('|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results.runs) {
    const m = r.median;
    if (m.paintMs === undefined) {
      console.log(`| ${r.profile} | ${r.scenario} | ${r.cache} | ${r.target} | all runs failed |`);
      continue;
    }
    const failed = m.failedRuns ? ` (${m.failedRuns} failed)` : '';
    console.log(
      `| ${r.profile} | ${r.scenario} | ${r.cache} | ${r.target} | ${s(m.paintMs)} | ${s(m.ttiMs)} | ${s(m.settledMs)} | ${kib(m.bytesDown)} | ${m.httpRequests} | ${m.wsFramesIn}/${m.wsFramesOut} | ${m.longTaskCount} (${m.longTaskTotalMs}) |${failed}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
