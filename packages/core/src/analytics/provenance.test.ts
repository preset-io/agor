import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithTenantContext } from '../db/tenant-context.js';
import { createAnalyticsLogger } from './logger.js';

const deploymentId = '59d8ce01-1106-4cbb-aa28-86d8330d72fb';

describe('ambient analytics provenance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('snapshots deployment and each tenant before batched delivery, preserving extras', async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      sent.push(...JSON.parse(init.body as string).batch);
      return new Response(null, { status: 200 });
    }));
    const config = {
      daemon: { deployment_id: deploymentId },
      analytics: {
        enabled: true,
        extras: { cell_id: 'cell-test', environment: 'cloud-sdx' },
        filters: { exclude_events: ['executor.heartbeat'] },
        plugins: [{
          type: 'http_batch' as const,
          enabled: true,
          options: { url: 'https://example.test/batch', max_batch_size: 3, flush_interval_ms: 10 },
        }],
      },
    };
    const logger = await createAnalyticsLogger(config);
    config.daemon.deployment_id = 'mutated-after-init';
    await Promise.all(['tenant-a', 'tenant-b'].map((tenant) => runWithTenantContext(tenant, async () => {
      await Promise.resolve();
      logger.track('task.created', { fixture: tenant }, {
        userId: 'test-user',
        context: { tenant_id: 'spoof', deployment_id: 'spoof', extras: { cell_id: 'spoof' } },
      });
      logger.track('executor.heartbeat');
    })));
    logger.track('daemon.event', {}, {
      userId: 'test-user', context: { tenant_id: 'spoof', deployment_id: 'spoof' },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    for (const event of sent) {
      const properties = event.properties as Record<string, unknown>;
      expect(event.context).toMatchObject({
        deployment_id: deploymentId,
        extras: { cell_id: 'cell-test', environment: 'cloud-sdx' },
      });
      if (properties.fixture) {
        expect(event.context).toHaveProperty('tenant_id', properties.fixture);
      } else {
        expect(event.context).not.toHaveProperty('tenant_id');
      }
    }
  });

  it('never accepts caller deployment identity without daemon configuration', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = await createAnalyticsLogger({
      enabled: true,
      plugins: [{ type: 'stdout', enabled: true }],
    });
    logger.track('daemon.event', {}, { context: { deployment_id: 'spoof' } });
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    expect(JSON.parse(log.mock.calls[0][0] as string).context).not.toHaveProperty('deployment_id');
  });
});
