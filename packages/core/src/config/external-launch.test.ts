import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertValidRawExternalLaunchConfig,
  resolveEffectiveExternalLaunchConfig,
  resolveExternalLaunchSettings,
  resolveValidExternalLaunchProvider,
} from './external-launch';
import type { AgorConfig } from './types';

const completeProvider = {
  enabled: true,
  exchange_url: 'https://issuer.example.test/exchange',
  issuer: 'https://issuer.example.test',
  audience: 'runtime:test',
  jwks_url: 'https://issuer.example.test/jwks',
} as const;

function publicKeyPem(type: 'rsa' | 'ec' | 'ed25519', namedCurve?: string): string {
  const { publicKey } =
    type === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2_048 })
      : type === 'ec'
        ? generateKeyPairSync('ec', { namedCurve: namedCurve ?? 'P-256' })
        : generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

function unsafeConfig(externalLaunch: Record<string, unknown>): AgorConfig {
  return { external_launch: externalLaunch } as unknown as AgorConfig;
}

describe('external launch effective config', () => {
  it('materializes supported environment overrides once', () => {
    const resolved = resolveEffectiveExternalLaunchConfig(
      {
        enabled: false,
        service_credential_env: 'CUSTOM_LAUNCH_TOKEN',
        dev_shared_secret_env: 'CUSTOM_LAUNCH_SECRET',
      },
      {
        AGOR_EXTERNAL_LAUNCH_ENABLED: 'true',
        AGOR_EXTERNAL_LAUNCH_EXCHANGE_URL: 'https://issuer.example.test/exchange',
        AGOR_EXTERNAL_LAUNCH_ISSUER: 'https://issuer.example.test',
        AGOR_EXTERNAL_LAUNCH_AUDIENCE: 'runtime:test',
        AGOR_EXTERNAL_LAUNCH_INSTANCE_ID: 'runtime-1',
        AGOR_EXTERNAL_LAUNCH_FORWARD_REQUEST_HOST: 'on',
        CUSTOM_LAUNCH_TOKEN: 'service-token',
        CUSTOM_LAUNCH_SECRET: 'assertion-secret',
      }
    );

    expect(resolved).toMatchObject({
      enabled: true,
      exchange_url: 'https://issuer.example.test/exchange',
      issuer: 'https://issuer.example.test',
      audience: 'runtime:test',
      instance_id: 'runtime-1',
      forward_request_host: true,
      service_credential: 'service-token',
      dev_shared_secret: 'assertion-secret',
    });
  });

  it('rejects invalid environment booleans instead of silently disabling auth', () => {
    expect(() =>
      resolveEffectiveExternalLaunchConfig(undefined, {
        AGOR_EXTERNAL_LAUNCH_ENABLED: 'sometimes',
      })
    ).toThrow(/AGOR_EXTERNAL_LAUNCH_ENABLED/);
  });

  it('fails startup for incomplete or ambiguous enabled providers', () => {
    expect(() =>
      resolveValidExternalLaunchProvider({ external_launch: { enabled: true } })
    ).toThrow(/exchange_url/);
    expect(() =>
      resolveValidExternalLaunchProvider({
        external_launch: {
          enabled: true,
          exchange_url: 'https://issuer.example.test/exchange',
          issuer: 'https://issuer.example.test',
          audience: 'runtime:test',
          jwks_url: 'https://issuer.example.test/jwks',
          public_key: 'also-configured',
        },
      })
    ).toThrow(/multiple assertion verification methods/);
  });

  it('accepts one complete effective provider configuration', () => {
    expect(() =>
      resolveValidExternalLaunchProvider({
        external_launch: {
          enabled: true,
          exchange_url: 'https://issuer.example.test/exchange',
          issuer: 'https://issuer.example.test',
          audience: 'runtime:test',
          jwks_url: 'https://issuer.example.test/jwks',
        },
      })
    ).not.toThrow();
  });

  it.each([
    ['non-HTTP exchange URL', { exchange_url: 'not-a-url' }, /exchange_url.*HTTP/i],
    [
      'credentials in the exchange URL',
      { exchange_url: 'https://user:secret@issuer.example.test/exchange' },
      /exchange_url.*URL credentials/i,
    ],
    ['non-HTTP JWKS URL', { jwks_url: 'file:///tmp/jwks.json' }, /jwks_url.*HTTP/i],
    [
      'credentials in the JWKS URL',
      { jwks_url: 'https://user:secret@issuer.example.test/jwks' },
      /jwks_url.*URL credentials/i,
    ],
    ['zero timeout', { request_timeout_ms: 0 }, /request_timeout_ms.*1/i],
    ['excessive timeout', { request_timeout_ms: 120_001 }, /request_timeout_ms.*120000/i],
    ['empty algorithms', { algorithms: [] }, /algorithms.*non-empty/i],
    ['unsupported algorithm', { algorithms: ['none'] }, /algorithms.*only contain/i],
    [
      'malformed public key',
      { jwks_url: undefined, public_key: 'not-a-public-key' },
      /public_key.*valid public key/i,
    ],
    ['numeric trusted header', { trusted_host_header: 42 }, /trusted_host_header.*string/i],
    ['invalid trusted header', { trusted_host_header: 'host header' }, /HTTP header name/i],
    ['non-boolean host forwarding', { forward_request_host: 'yes' }, /must be a boolean/i],
  ])('fails startup for an enabled provider with %s', (_label, override, expected) => {
    expect(() =>
      resolveValidExternalLaunchProvider(unsafeConfig({ ...completeProvider, ...override }))
    ).toThrow(expected);
  });

  it('requires configured algorithms to match the verification key family', () => {
    expect(() =>
      resolveValidExternalLaunchProvider(
        unsafeConfig({
          ...completeProvider,
          jwks_url: undefined,
          dev_shared_secret: 'secret',
          algorithms: ['ES256'],
        })
      )
    ).toThrow(/symmetric verification.*HS/i);
  });

  it('derives a curve-compatible default for an EC public key', () => {
    const settings = resolveValidExternalLaunchProvider(
      unsafeConfig({
        ...completeProvider,
        jwks_url: undefined,
        public_key: publicKeyPem('ec', 'P-256'),
      })
    );

    expect(settings.algorithms).toEqual(['ES256']);
    expect(settings.publicKey).toMatchObject({ type: 'public', asymmetricKeyType: 'ec' });
    expect(typeof settings.publicKey).not.toBe('string');
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.algorithms)).toBe(true);
  });

  it.each([
    [
      'an EC key with an RSA algorithm',
      publicKeyPem('ec', 'P-256'),
      ['RS256'],
      /curve.*requires.*ES256/i,
    ],
    [
      'an EC key with the wrong curve algorithm',
      publicKeyPem('ec', 'P-256'),
      ['ES384'],
      /curve.*requires.*ES256/i,
    ],
    ['an RSA key with an EC algorithm', publicKeyPem('rsa'), ['ES256'], /RSA.*RS\* or PS\*/i],
    ['an unsupported key type', publicKeyPem('ed25519'), ['RS256'], /unsupported key type/i],
  ])('rejects %s', (_label, publicKey, algorithms, expected) => {
    expect(() =>
      resolveValidExternalLaunchProvider(
        unsafeConfig({
          ...completeProvider,
          jwks_url: undefined,
          public_key: publicKey,
          algorithms,
        })
      )
    ).toThrow(expected);
  });

  it('rejects malformed raw env selectors with a stable config error', () => {
    expect(() =>
      resolveEffectiveExternalLaunchConfig(
        unsafeConfig({ service_credential_env: 42 }).external_launch,
        {}
      )
    ).toThrow(/Config error: external_launch\.service_credential_env must be a non-empty string/i);
  });

  it('validates raw launch settings without mutating caller-owned config', () => {
    const configured = {
      login_redirect_url: ' https://workspace.example.test/open ',
      return_host_param: ' workspace_host ',
    };

    assertValidRawExternalLaunchConfig(configured);

    expect(configured).toEqual({
      login_redirect_url: ' https://workspace.example.test/open ',
      return_host_param: ' workspace_host ',
    });
  });

  it('returns the normalized settings consumed by request handling', () => {
    const result = resolveExternalLaunchSettings(
      unsafeConfig({
        ...completeProvider,
        algorithms: ['ES256'],
        trusted_host_header: 'X-Forwarded-Host',
        request_timeout_ms: 5_000,
      })
    );

    expect(result.error).toBeUndefined();
    expect(result.settings).toMatchObject({
      enabled: true,
      exchangeUrl: completeProvider.exchange_url,
      jwksUrl: completeProvider.jwks_url,
      algorithms: ['ES256'],
      trustedHostHeader: 'x-forwarded-host',
      requestTimeoutMs: 5_000,
    });
  });
});
