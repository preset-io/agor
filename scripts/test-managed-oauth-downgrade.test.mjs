import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { publishedImageEnvironment, validateOldImage } from './managed-oauth-old-image-proof.mjs';
import {
  OLD_PACKAGE_INTEGRITY,
  OLD_PACKAGE_SHA,
  validatePublishedPackageLock,
} from './managed-oauth-old-package-proof.mjs';
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

test('published old daemon requires a digest from the single pinned image repository', () => {
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

test('published npm proof pins artifact, embedded revision and every external dependency', async () => {
  const lock = JSON.parse(
    await readFile(
      new URL('./fixtures/managed-old-package/package-lock.json', import.meta.url),
      'utf8'
    )
  );
  validatePublishedPackageLock(lock);
  assert.match(OLD_PACKAGE_SHA, /^[a-f0-9]{40}$/);
  assert.equal(lock.packages['node_modules/agor-live'].integrity, OLD_PACKAGE_INTEGRITY);
  assert.equal(parseOptions(['--old-package', '0.26.3']).oldPackage, '0.26.3');
  assert.throws(() => parseOptions(['--old-package', 'latest']));
  assert.throws(() =>
    parseOptions([
      '--old-package',
      '0.26.3',
      '--old-image',
      `docker.io/preset/agor@sha256:${'a'.repeat(64)}`,
    ])
  );
  for (const mutation of [
    (x) => {
      x.packages['node_modules/agor-live'].integrity = `sha512-${'a'.repeat(86)}==`;
    },
    (x) => {
      x.packages['node_modules/@agor-live/client'].resolved = 'https://foreign.invalid/client.tgz';
    },
    (x) => {
      delete x.packages['node_modules/@agor-live/client'].integrity;
    },
  ]) {
    const changed = structuredClone(lock);
    mutation(changed);
    assert.throws(() => validatePublishedPackageLock(changed));
  }
});

test('publication policy admits only the isolated immutable compatibility consumer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'image-policy-proof-'));
  const files = [
    '.agor.yml',
    '.github/workflows/build-image.yml',
    '.github/workflows/postgres-integration.yml',
    'scripts/check-image-publication-policy.mjs',
    'scripts/managed-oauth-old-image-proof.mjs',
    'scripts/managed-oauth-old-package-proof.mjs',
    'docker/Dockerfile',
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
    const dockerPath = join(directory, 'docker/Dockerfile');
    const dockerfile = await readFile(dockerPath, 'utf8');
    await writeFile(
      dockerPath,
      dockerfile.replace('COPY patches/ ./patches/', '# missing patches')
    );
    await assert.rejects(run);
    await writeFile(dockerPath, dockerfile);
    const workflowPath = join(directory, files[2]);
    const workflow = await readFile(workflowPath, 'utf8');
    await writeFile(workflowPath, workflow.replace('--old-package 0.26.3', '--old-package latest'));
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
