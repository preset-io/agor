import { describe, expect, it, vi } from 'vitest';
import type { Application } from '../declarations.js';
import { initializeDistributedWorkIdentity } from './distributed-work-identity.js';

function makeApplicationSettings() {
  const settings = new Map<string, unknown>();
  const app = {
    get: vi.fn((name: string) => settings.get(name)),
    set: vi.fn((name: string, value: unknown) => {
      settings.set(name, value);
      return app;
    }),
  } as unknown as Pick<Application, 'get' | 'set'>;
  return { app, settings };
}

describe('daemon distributed-work identity lifecycle', () => {
  it('generates once and shares the same app-owned identity with every consumer', () => {
    const { app } = makeApplicationSettings();
    const generateBootId = vi.fn(() => 'boot-one');

    const initialized = initializeDistributedWorkIdentity(app, {
      environment: { AGOR_DAEMON_INSTANCE_ID: 'env-b', HOSTNAME: 'host-c' },
      generateBootId,
    });
    const repeated = initializeDistributedWorkIdentity(app, {
      environment: {},
      generateBootId,
    });
    const schedulerConsumer = app.get('distributedWorkIdentity');
    const futureWorkerConsumer = app.get('distributedWorkIdentity');

    expect(generateBootId).toHaveBeenCalledOnce();
    expect(initialized.instanceId).toBe('env-b');
    expect(repeated).toBe(initialized);
    expect(schedulerConsumer).toBe(initialized);
    expect(futureWorkerConsumer).toBe(initialized);
  });
});
