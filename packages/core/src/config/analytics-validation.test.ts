import { describe, expect, it } from 'vitest';
import { validateAnalyticsHeaders, validateAnalyticsMetadata } from './analytics-validation.js';
import { assertValidRawConfig } from './config-manager.js';
import type { AgorAnalyticsHttpBatchPluginSettings, AgorAnalyticsSettings } from './types.js';

describe('analytics config bounds', () => {
  it('accepts exact metadata bounds and flat scalar values', () => {
    const extras = Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [`key${i}`, 'é'.repeat(512)])
    );
    expect(() =>
      assertValidRawConfig({ analytics: { extras, client: { app: 'a'.repeat(256), version: 0 } } })
    ).not.toThrow();
    expect(() =>
      validateAnalyticsMetadata({ extras: { ['k'.repeat(64)]: true, number: 1.5 } })
    ).not.toThrow();
  });

  it.each([
    null,
    [],
    'bad',
    { nested: {} },
    { array: [] },
    { empty: null },
    { nonfinite: Infinity },
    { nonfinite: NaN },
    { ['k'.repeat(65)]: 'x' },
    { 'bad key': true },
    { large: 'é'.repeat(513) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])),
    JSON.parse('{"__proto__":"bad"}'),
    { constructor: 'bad' },
    { prototype: true },
    Object.create({ inherited: 'bad' }),
  ])('rejects invalid extras case %#, even when disabled', (extras) => {
    expect(() => assertValidRawConfig({ analytics: { enabled: false, extras } })).toThrow(
      'invalid analytics extras'
    );
  });

  it.each([
    { app: '' },
    { app: 'a'.repeat(257) },
    { app: 1 },
    { version: Infinity },
    { version: '' },
    { version: 'a'.repeat(257) },
    { debug: 'yes' },
  ])('rejects invalid client case %#', (client) => {
    expect(() => validateAnalyticsMetadata({ client } as AgorAnalyticsSettings)).toThrow(
      'invalid analytics client'
    );
  });

  it('accepts bounded static headers and unresolved env names', () => {
    expect(() =>
      assertValidRawConfig({
        analytics: {
          plugins: [
            {
              type: 'http_batch',
              enabled: false,
              options: {
                headers: { ['x'.repeat(128)]: 'x'.repeat(8192) },
                headers_from_env: { Authorization: 'A'.repeat(128) },
              },
            },
          ],
        },
      })
    ).not.toThrow();
  });

  it.each([
    {
      headers: { Authorization: 'synthetic' },
      headers_from_env: { authorization: 'AGOR_ANALYTICS_AUTHORIZATION' },
    },
    { headers_from_env: { Authorization: 'ONE', authorization: 'TWO' } },
    { headers: { X: 'one', x: 'two' } },
    { headers_from_env: { 'bad:name': 'VALID' } },
    { headers_from_env: { Authorization: '' } },
    { headers_from_env: { Authorization: 'NOT-A-NAME' } },
    { headers_from_env: { Authorization: 'A'.repeat(129) } },
    { headers_from_env: { Authorization: 'PATH' } },
    { headers_from_env: { Authorization: 'LC_SECRET' } },
    { headers_from_env: { Authorization: 'AGOR_CLOUD_SECRET' } },
    { headers_from_env: JSON.parse('{"__proto__":"VALID"}') },
    { headers: { prototype: 'value' } },
    { headers: { X: 'secret\r\nx: yes' } },
    { headers: { X: 'é' } },
    { headers: { X: 'secret\0' } },
    { headers: { X: 'x'.repeat(8193) } },
    { headers: { ['x'.repeat(129)]: 'value' } },
    { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, 'value'])) },
  ])('rejects unsafe/conflicting header config case %# without echoing values', (options) => {
    const typedOptions = options as AgorAnalyticsHttpBatchPluginSettings['options'];
    expect(() => validateAnalyticsHeaders(typedOptions)).toThrow(
      /^Config error: invalid analytics /
    );
    expect(() =>
      assertValidRawConfig({
        analytics: { plugins: [{ type: 'http_batch', enabled: false, options: typedOptions }] },
      })
    ).toThrow(/^Config error: invalid analytics /);
  });
});
