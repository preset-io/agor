// Run: node --test apps/agor-ui/scripts/test-global-search-retention.mjs
// Requires repository Playwright Chromium. Builds real production React, serves
// real loopback HTTP, and tests collection (not merely absence from a store).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { build } from 'vite';

async function payloadCount(cdp) {
  // Raw snapshots remain in this process only; no heap files are published.
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
  let count = 0;
  for (let i = 0; i < nodes.length; i += fields.length) {
    if (
      nodes[i + fields.indexOf('self_size')] >= 256 * 1024 &&
      /^RETENTION_\d+_\d+_/.test(strings[nodes[i + fields.indexOf('name')]])
    )
      count++;
  }
  return count;
}

test('GlobalSearch releases obsolete payloads across two mounted cycles', {
  timeout: 120_000,
}, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'agor-search-retention-'));
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
          input: path.resolve(
            import.meta.dirname,
            '../src/components/GlobalSearch/GlobalSearch.retention.fixture.tsx'
          ),
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
    await page.waitForFunction(() => !!window.searchRetentionFixture);
    const cdp = await page.context().newCDPSession(page);
    for (let cycle = 1; cycle <= 2; cycle++) {
      await page.evaluate((n) => window.searchRetentionFixture.populate(n), cycle);
      await page.waitForTimeout(300);
      if (cycle === 2) {
        await page.keyboard.press('Control+k');
        await page.getByRole('combobox', { name: 'Global search' }).fill('search fixture');
        await page.waitForTimeout(300);
      }
      assert.equal(await page.evaluate(() => window.searchRetentionFixture.alive()), 32);
      assert.equal(await payloadCount(cdp), 32, 'positive control: all payload strings are live');
      await page.evaluate(() => window.searchRetentionFixture.archive());
      // React legitimately retains one previous render in the alternate fiber.
      // A second bounded commit retires it; the component stays mounted, with
      // the original shortcut listener and query/flush identities unchanged.
      await page.waitForTimeout(300);
      await page.evaluate(() => window.searchRetentionFixture.archive());
      await page.waitForTimeout(300);
      await cdp.send('HeapProfiler.collectGarbage');
      assert.equal(
        await payloadCount(cdp),
        0,
        `cycle ${cycle}: obsolete description payloads survived GC`
      );
      if (cycle === 2) await page.getByRole('button', { name: 'Close search' }).click();
      assert.equal(
        await page.evaluate(() => window.searchRetentionFixture.alive()),
        0,
        `cycle ${cycle}: obsolete session objects (and their descriptions) remain reachable`
      );
    }
    await page.evaluate(() => window.searchRetentionFixture.unmount());
  } finally {
    await browser?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(outDir, { recursive: true, force: true });
  }
});
