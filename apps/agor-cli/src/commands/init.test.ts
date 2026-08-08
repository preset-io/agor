import { describe, expect, it } from 'vitest';
import { createInstallTelemetryConfig, isFreshInitState, shouldDeferAdminSetup } from './init.js';

describe('safe init state detection', () => {
  it('treats a pre-created empty .agor mount as fresh', () => {
    expect(
      isFreshInitState({
        baseExists: true,
        databaseExists: false,
        reposExist: false,
        branchesExist: false,
      })
    ).toBe(true);
  });

  it('does not treat existing data as fresh', () => {
    expect(
      isFreshInitState({
        baseExists: true,
        databaseExists: true,
        reposExist: true,
        branchesExist: true,
      })
    ).toBe(false);
  });
});

describe('install telemetry config', () => {
  it('does not mutate an opted-out config for the one-time install ping', () => {
    const config = { telemetry: { enabled: false, instance_id: 'stable-id' } };

    const deliveryConfig = createInstallTelemetryConfig(config, 'stable-id');

    expect(deliveryConfig.telemetry?.enabled).toBe(true);
    expect(config.telemetry.enabled).toBe(false);
  });
});

describe('headless admin bootstrap', () => {
  it('always defers admin creation during noninteractive init', () => {
    expect(shouldDeferAdminSetup(true, 'development')).toBe(true);
    expect(shouldDeferAdminSetup(true, undefined)).toBe(true);
  });

  it('retains the explicit local force-init development convenience', () => {
    expect(shouldDeferAdminSetup(false, 'development')).toBe(false);
    expect(shouldDeferAdminSetup(false, 'production')).toBe(true);
  });
});
