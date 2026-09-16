import assert from 'node:assert/strict';
import { test } from 'node:test';
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
