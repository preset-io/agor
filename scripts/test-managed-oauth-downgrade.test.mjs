import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { publishedImageEnvironment, validateOldImage } from './managed-oauth-old-image-proof.mjs';
import {
  BASELINE_SHA,
  isolatedEnvironment,
  parseOptions,
  SCHEMA_SHA,
} from './test-managed-oauth-downgrade.mjs';

test('pins immutable old/new source defaults', () => {
  assert.deepEqual(parseOptions([]), { baseline: BASELINE_SHA, schema: SCHEMA_SHA });
  assert.deepEqual(parseOptions(['--baseline-sha', 'a'.repeat(40)]), {
    baseline: 'a'.repeat(40),
    schema: SCHEMA_SHA,
  });
});
test('rejects external database/source paths, missing refs and mutable refs', () => {
  for (const args of [
    ['--database-url', 'postgresql://shared.invalid'],
    ['--schema-sha', 'main'],
    ['--baseline-sha'],
    ['--source', '/unowned'],
  ])
    assert.throws(() => parseOptions(args));
});
test('environment is an allowlist, not inherited credentials or runtime configuration', () => {
  const env = isolatedEnvironment('/tmp/synthetic-proof-home');
  assert.deepEqual(Object.keys(env).sort(), [
    'AGOR_DATA_HOME',
    'AGOR_DB_DIALECT',
    'HOME',
    'NODE_ENV',
    'PATH',
    'USERPROFILE',
  ]);
  assert.equal(env.HOME, '/tmp/synthetic-proof-home');
  assert.equal(env.AGOR_DATA_HOME, env.HOME);
});

test('published old daemon requires a digest from the single public image repository', () => {
  const image = `docker.io/preset/agor@sha256:${'a'.repeat(64)}`;
  assert.equal(parseOptions(['--old-image', image]).oldImage, image);
  for (const value of [
    undefined,
    'preset/agor:main',
    image.replace('preset/agor', 'foreign/agor'),
    `${image}\n`,
  ])
    assert.throws(() => validateOldImage(value));
});

test('published daemon credentials come only from the generated run-owned role', () => {
  const env = publishedImageEnvironment({
    user: `runtime_${'a'.repeat(32)}`,
    database: 'agor',
    password: 'synthetic',
  });
  assert.match(env.DATABASE_URL, /@owned-postgres:5432\/agor$/);
  assert.equal(env.AGOR_TELEMETRY, '0');
  assert.equal(env.AGOR_CONFIG_PATH, '/home/agor/config.yaml');
  assert.throws(() => publishedImageEnvironment({ user: 'shared', database: 'agor' }));
});

test('publication policy admits only the isolated immutable compatibility consumer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'image-policy-proof-'));
  const files = [
    '.agor.yml',
    '.github/workflows/build-image.yml',
    '.github/workflows/postgres-integration.yml',
    'scripts/check-image-publication-policy.mjs',
    'scripts/managed-oauth-old-image-proof.mjs',
  ];
  const run = () =>
    promisify(execFile)(process.execPath, [join(directory, files[3])], { timeout: 10000 });
  try {
    for (const file of files) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await writeFile(
        join(directory, file),
        await readFile(new URL(`../${file}`, import.meta.url))
      );
    }
    await run();
    const workflowPath = join(directory, files[2]);
    const workflow = await readFile(workflowPath, 'utf8');
    await writeFile(workflowPath, workflow.replace(/agor@sha256:[a-f0-9]{64}/, 'agor:main'));
    await assert.rejects(run);
    await writeFile(
      workflowPath,
      `${workflow}\n# additional unreviewed preset/agor:main consumer\n`
    );
    await assert.rejects(run);
    await writeFile(workflowPath, workflow);
    await writeFile(join(directory, 'unreviewed.sh'), 'docker pull preset/agor:main\n');
    await assert.rejects(run);
    await rm(join(directory, 'unreviewed.sh'));
    const proofPath = join(directory, files[4]);
    await writeFile(
      proofPath,
      (await readFile(proofPath, 'utf8')).replace("'--internal'", "'--attachable'")
    );
    await assert.rejects(run);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
