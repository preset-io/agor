import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const docsDir = fileURLToPath(new URL('../', import.meta.url));
const validator = join(docsDir, 'scripts/validate-analytics.ts');
const measurementId = 'G-TEST';
const campaigns = [
  'beyond-the-sandbox',
  'costs-under-control-solution',
  'costs-under-control',
  'dev-team',
  'not-alone-problem',
  'not-alone',
  'not-just-a-tool',
  'right-where-you-work',
  'selfware-is-dead',
  'team-sport',
];
const markers =
  'google-analytics-loader google-analytics-config send_page_view __agorGaLastLocation';

function validate(change?: (out: string) => void) {
  const fixture = mkdtempSync(join(tmpdir(), 'agor-analytics-export-'));
  const out = join(fixture, 'out');
  mkdirSync(out);
  try {
    writeFileSync(join(out, 'index.html'), `<html>${measurementId}</html>`);
    writeFileSync(join(out, 'app.js'), markers);
    for (const slug of campaigns) {
      cpSync(join(docsDir, 'public', slug), join(out, slug), { recursive: true });
    }
    change?.(out);
    // Resolve tsx from this workspace, not the disposable fixture's directory.
    return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), validator], {
      cwd: fixture,
      env: { ...process.env, NEXT_PUBLIC_GA_ID: measurementId },
      encoding: 'utf8',
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test('validates rendered pages and all ten real, uninstrumented redirect stubs', () => {
  const result = validate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 exported pages and 10 uninstrumented redirects/);
});

for (const count of [0, 2]) {
  test(`rejects a rendered page with ${count} analytics IDs`, () => {
    const result = validate((out) => {
      writeFileSync(join(out, 'index.html'), measurementId.repeat(count));
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected exactly one/);
  });
}

for (const replacement of ['https://example.com/', '../elsewhere']) {
  test(`rejects redirect drift to ${replacement}`, () => {
    const result = validate((out) => {
      const file = join(out, campaigns[0], 'index.html');
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('../', replacement));
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be an uninstrumented, noindex redirect/);
  });
}

test('rejects instrumentation on a redirect and missing stubs', () => {
  for (const remove of [false, true]) {
    const result = validate((out) => {
      const file = join(out, campaigns[0], 'index.html');
      if (remove) rmSync(dirname(file), { recursive: true });
      else writeFileSync(file, `${readFileSync(file, 'utf8')}<script>${measurementId}</script>`);
    });
    assert.notEqual(result.status, 0);
  }
});

test('does not exempt unnamed redirects or relax the bundled analytics checks', () => {
  for (const unnamed of [false, true]) {
    const result = validate((out) => {
      if (unnamed) cpSync(join(out, campaigns[0]), join(out, 'unexpected'), { recursive: true });
      else writeFileSync(join(out, 'app.js'), `${markers} google-analytics-loader`);
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected exactly one/);
  }
});
