import { getDefaultConfig } from '@agor/core/config';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon } from './index.js';

const BOOTSTRAP_REQUIRED = 'AGOR_TENANT_RUNTIME_BOOTSTRAP_REQUIRED';

describe('daemon startup managed-runtime barrier', () => {
  afterEach(() => {
    delete process.env[BOOTSTRAP_REQUIRED];
  });

  it('evaluates the bootstrap scope on the real startDaemon path before later startup phases', async () => {
    process.env[BOOTSTRAP_REQUIRED] = 'false';
    const config = getDefaultConfig();
    config.daemon = {
      ...config.daemon,
      deployment_id: '11111111-1111-4111-8111-111111111111',
    };

    await expect(startDaemon({ config })).rejects.toMatchObject({
      name: 'TenantRuntimeBootstrapError',
      code: 'invalid_configuration',
    });
  });
});
