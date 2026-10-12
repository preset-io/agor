// Shared by the production retention tests. Requires repository Playwright
// Chromium. Builds real production React, serves real loopback HTTP, and lets
// tests observe collection (not merely absence from a store).
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';

/**
 * Labels of live strings of at least `minBytes` whose content matches `pattern`
 * (first capture group, or the whole match). Raw snapshots remain in this
 * process only; no heap files are published.
 */
export async function livePayloads(cdp, pattern, minBytes = 256 * 1024) {
  const chunks = [];
  const onChunk = ({ chunk }) => chunks.push(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot');
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  }
  const { snapshot, nodes, strings } = JSON.parse(chunks.join(''));
  const fields = snapshot.meta.node_fields;
  const labels = [];
  for (let i = 0; i < nodes.length; i += fields.length) {
    const match =
      nodes[i + fields.indexOf('self_size')] >= minBytes &&
      pattern.exec(strings[nodes[i + fields.indexOf('name')]]);
    if (match) labels.push(match[1] ?? match[0]);
  }
  return labels;
}

/** Build `src/components/<fixture>.fixture.tsx` as production React and drive it in Chromium. */
export async function withProductionFixture(fixture, run) {
  const outDir = await mkdtemp(path.join(tmpdir(), 'agor-retention-'));
  let browser;
  let server;
  try {
    await build({
      configFile: false,
      root: path.resolve(import.meta.dirname, '..'),
      logLevel: 'warn',
      resolve: { conditions: ['source'] },
      define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
      build: {
        outDir,
        minify: true,
        rolldownOptions: {
          input: path.resolve(import.meta.dirname, `../src/components/${fixture}.fixture.tsx`),
          output: { entryFileNames: 'fixture.js' },
        },
      },
    });
    server = createServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<div id="root"></div><script type="module" src="/fixture.js"></script>');
        return;
      }
      const file = path.resolve(outDir, `.${req.url}`);
      if (!file.startsWith(`${outDir}/`)) return res.writeHead(403).end();
      try {
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(await readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // No fabricated document or external application requests.
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
    );
    await page.goto(origin);
    const cdp = await page.context().newCDPSession(page);
    await run(page, cdp);
  } finally {
    await browser?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(outDir, { recursive: true, force: true });
  }
}
