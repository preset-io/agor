import { describe, expect, it } from 'vitest';
import {
  assertValidEffectiveExternalLaunchConfig,
  resolveEffectiveExternalLaunchConfig,
} from './external-launch';

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
      assertValidEffectiveExternalLaunchConfig({ external_launch: { enabled: true } })
    ).toThrow(/exchange_url/);
    expect(() =>
      assertValidEffectiveExternalLaunchConfig({
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
      assertValidEffectiveExternalLaunchConfig({
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
});
