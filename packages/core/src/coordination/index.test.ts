import { describe, expect, it } from 'vitest';
import {
  boundedBackoffDelay,
  createDistributedWorkIdentity,
  initialWorkOffset,
  jitterDelay,
} from './index';

describe('distributed work diagnostic identity', () => {
  it('uses configured, daemon-env, hostname, then fallback precedence', () => {
    const generateBootId = () => 'boot-1';
    expect(
      createDistributedWorkIdentity({
        configuredInstanceId: ' configured ',
        environment: { AGOR_DAEMON_INSTANCE_ID: ' env ', HOSTNAME: ' host ' },
        fallbackInstanceId: 'fallback',
        generateBootId,
      }).instanceId
    ).toBe('configured');
    expect(
      createDistributedWorkIdentity({
        environment: { AGOR_DAEMON_INSTANCE_ID: ' env ', HOSTNAME: ' host ' },
        fallbackInstanceId: 'fallback',
        generateBootId,
      }).instanceId
    ).toBe('env');
    expect(
      createDistributedWorkIdentity({
        environment: { HOSTNAME: ' host ' },
        fallbackInstanceId: 'fallback',
        generateBootId,
      }).instanceId
    ).toBe('host');
    expect(
      createDistributedWorkIdentity({ fallbackInstanceId: ' fallback ', generateBootId }).instanceId
    ).toBe('fallback');
    expect(createDistributedWorkIdentity({ generateBootId }).instanceId).toBe('daemon');
  });

  it('trims values and skips invalid empty precedence candidates', () => {
    expect(
      createDistributedWorkIdentity({
        configuredInstanceId: '   ',
        environment: { AGOR_DAEMON_INSTANCE_ID: '\t', HOSTNAME: '  stable-host  ' },
        fallbackInstanceId: '  fallback  ',
        generateBootId: () => '  boot-trimmed  ',
      })
    ).toEqual({ instanceId: 'stable-host', bootId: 'boot-trimmed' });

    expect(
      createDistributedWorkIdentity({
        configuredInstanceId: '',
        environment: { AGOR_DAEMON_INSTANCE_ID: '', HOSTNAME: '' },
        fallbackInstanceId: ' ',
        generateBootId: () => 'boot-fallback',
      }).instanceId
    ).toBe('daemon');
  });

  it('uses the injected boot ID generator once and rejects an empty result', () => {
    let calls = 0;
    const identity = createDistributedWorkIdentity({
      generateBootId: () => {
        calls += 1;
        return 'deterministic-boot';
      },
    });

    expect(identity).toEqual({ instanceId: 'daemon', bootId: 'deterministic-boot' });
    expect(calls).toBe(1);
    expect(() => createDistributedWorkIdentity({ generateBootId: () => '  ' })).toThrow(
      'boot ID generator returned an empty value'
    );
  });
});

describe('distributed work delay helpers', () => {
  it('computes deterministic symmetric jitter', () => {
    expect(jitterDelay(1_000, 0.2, 0)).toBe(800);
    expect(jitterDelay(1_000, 0.2, 0.5)).toBe(1_000);
    expect(jitterDelay(1_000, 0.2, 1)).toBe(1_200);
  });

  it('caps exponential idle backoff before jitter', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 2_000, jitterRatio: 0.1 };
    expect(boundedBackoffDelay(0, policy, 0.5)).toBe(1_000);
    expect(boundedBackoffDelay(1, policy, 0.5)).toBe(2_000);
    expect(boundedBackoffDelay(20, policy, 1)).toBe(2_200);
  });

  it('computes a deterministic uniform startup offset', () => {
    expect(initialWorkOffset(30_000, 0)).toBe(0);
    expect(initialWorkOffset(30_000, 0.25)).toBe(7_500);
    expect(initialWorkOffset(30_000, 1)).toBe(30_000);
  });
});
