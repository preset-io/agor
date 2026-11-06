import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnpatchedBrotliDecoder } from '../bin/version-check.js';

test('flags supported releases before the Brotli decoder fix', () => {
  for (const version of ['22.12.0', '22.23.3', '24.19.0', '24.22.0', '26.12.0']) {
    assert.equal(hasUnpatchedBrotliDecoder(version), true, version);
  }
});

test('flags end-of-life lines that never receive the fix', () => {
  for (const version of ['23.11.1', '25.4.0']) {
    assert.equal(hasUnpatchedBrotliDecoder(version), true, version);
  }
});

test('accepts fixed releases and newer lines', () => {
  for (const version of ['22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '27.0.0']) {
    assert.equal(hasUnpatchedBrotliDecoder(version), false, version);
  }
});
