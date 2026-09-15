import assert from 'node:assert/strict';
import { test } from 'node:test';
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
