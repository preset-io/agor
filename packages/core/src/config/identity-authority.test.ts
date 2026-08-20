import { describe, expect, it } from 'vitest';
import { assertValidEffectiveIdentityConfig, resolveIdentityAuthority } from './identity-authority';
import type { AgorConfig } from './types';

function externalConfig(overrides: Partial<AgorConfig> = {}): AgorConfig {
  return {
    identity: {
      user_lifecycle: 'external',
      role_authority: 'claims',
      local_auth: 'disabled',
      external: { provider: 'external_launch', provisioning: 'jit' },
    },
    external_launch: { enabled: true },
    ...overrides,
  };
}

describe('identity authority', () => {
  it('defaults omitted config to local authority', () => {
    expect(resolveIdentityAuthority({})).toEqual({
      contractVersion: 1,
      userLifecycle: 'internal',
      roleAuthority: 'internal',
      localAuth: 'enabled',
      capabilities: {
        users: {
          create: true,
          delete: true,
          identityWrite: true,
          roleWrite: true,
          passwordWrite: true,
          avatarSettingsWrite: true,
          selfConfigurationWrite: true,
        },
      },
    });
  });

  it('derives externally managed capabilities from the coherent external profile', () => {
    const config = externalConfig();
    expect(() => assertValidEffectiveIdentityConfig(config, {})).not.toThrow();
    expect(resolveIdentityAuthority(config)).toMatchObject({
      userLifecycle: 'external',
      roleAuthority: 'claims',
      localAuth: 'disabled',
      external: { provider: 'external_launch', provisioning: 'jit' },
      capabilities: {
        users: {
          create: false,
          delete: false,
          identityWrite: false,
          roleWrite: false,
          passwordWrite: false,
          avatarSettingsWrite: false,
          selfConfigurationWrite: true,
        },
      },
    });
  });

  it('rejects partial or contradictory external authority profiles', () => {
    expect(() =>
      assertValidEffectiveIdentityConfig({
        identity: { user_lifecycle: 'external' },
        external_launch: { enabled: true },
      })
    ).toThrow(/role_authority 'claims'/);
    expect(() =>
      assertValidEffectiveIdentityConfig({
        identity: {
          user_lifecycle: 'external',
          role_authority: 'claims',
          local_auth: 'enabled',
          external: { provider: 'external_launch', provisioning: 'jit' },
        },
        external_launch: { enabled: true },
      })
    ).toThrow(/local_auth 'disabled'/);
    expect(() =>
      assertValidEffectiveIdentityConfig({
        identity: {
          user_lifecycle: 'external',
          role_authority: 'claims',
          local_auth: 'disabled',
        },
        external_launch: { enabled: true },
      })
    ).toThrow(/identity\.external\.provider/);
  });

  it('requires the external launch provisioner and rejects bootstrap role mutation', () => {
    expect(() =>
      assertValidEffectiveIdentityConfig(
        externalConfig({ external_launch: { enabled: false } }),
        {}
      )
    ).toThrow(/external_launch\.enabled/);

    expect(() =>
      assertValidEffectiveIdentityConfig(
        externalConfig({
          execution: { bootstrap_superadmin_users: ['user-1'] },
        }),
        {}
      )
    ).toThrow(/bootstrap_superadmin_users/);
  });

  it('accepts the documented environment override for external launch enablement', () => {
    const config = externalConfig({ external_launch: { enabled: false } });
    expect(() =>
      assertValidEffectiveIdentityConfig(config, { AGOR_EXTERNAL_LAUNCH_ENABLED: 'true' })
    ).not.toThrow();
  });
});
