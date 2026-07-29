import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  markWriteDataPrepared,
  rejectExternalTenantIdWrite,
} from '../utils/write-data-boundary.js';
import { GatewayChannelsService } from './gateway-channels.js';
import { SchedulesService } from './schedules.js';

describe('tenant-owned public write boundary', () => {
  const context = (
    method: 'create' | 'update' | 'patch',
    provider: string | undefined,
    data: unknown
  ) => ({ method, data, params: { provider } }) as HookContext;

  it.each([
    ['create', 'rest'],
    ['update', 'socketio'],
    ['patch', 'mcp'],
  ] as const)('rejects tenant_id on external %s through %s', (method, provider) => {
    expect(() =>
      rejectExternalTenantIdWrite(
        context(method, provider, { name: 'caller data', tenant_id: 'caller-tenant' })
      )
    ).toThrow('tenant_id cannot be supplied on tenant-owned writes');
  });

  it('rejects tenant_id in an external multi-create item', () => {
    expect(() =>
      rejectExternalTenantIdWrite(
        context('create', 'rest', [
          { name: 'first' },
          { name: 'second', tenant_id: 'caller-tenant' },
        ])
      )
    ).toThrow('tenant_id cannot be supplied on tenant-owned writes');
  });

  it('leaves valid external DTOs unchanged', () => {
    const data = { name: 'valid', config: { tenant_id: 'domain value' } };
    const hook = context('create', 'rest', data);

    expect(rejectExternalTenantIdWrite(hook)).toBe(hook);
    expect(hook.data).toBe(data);
  });

  it('leaves trusted internal DTOs unchanged', () => {
    const data = { name: 'trusted', tenant_id: 'trusted-internal-tenant' };
    const hook = context('patch', undefined, data);

    expect(rejectExternalTenantIdWrite(hook)).toBe(hook);
    expect(hook.data).toBe(data);
  });

  it('ignores inherited and non-enumerable tenant identity fields', () => {
    const inherited = Object.assign(Object.create({ tenant_id: 'inherited' }), {
      name: 'inherited field',
    });
    const hidden = { name: 'hidden field' };
    Object.defineProperty(hidden, 'tenant_id', {
      value: 'hidden',
      enumerable: false,
    });

    expect(rejectExternalTenantIdWrite(context('create', 'rest', inherited)).data).toBe(inherited);
    expect(rejectExternalTenantIdWrite(context('create', 'rest', hidden)).data).toBe(hidden);
  });
});

describe('runtime write-data boundaries', () => {
  it.each([
    ['schedule_id', 'caller-supplied-id'],
    ['last_run_at', 123],
    ['last_run_session_id', 'caller-supplied-session'],
    ['next_run_at', 456],
    ['created_at', '2026-07-28T00:00:00.000Z'],
  ])('rejects runtime-owned schedule create field %s', async (field, value) => {
    const service = new SchedulesService(null as never);

    await expect(
      service.create({
        branch_id: '00000000-0000-7000-8000-000000000001',
        name: 'Nightly',
        cron_expression: '0 0 * * *',
        timezone_mode: 'utc',
        prompt: 'Run',
        agentic_tool_config: { agentic_tool: 'codex' },
        [field]: value,
      } as never)
    ).rejects.toThrow(`Schedule contains unsupported write fields: ${field}`);
  });

  it('rejects a runtime-owned schedule cursor on direct patch', async () => {
    const service = new SchedulesService(null as never);
    await expect(service.patch('schedule-id', { next_run_at: 456 } as never)).rejects.toThrow(
      'Schedule contains unsupported write fields: next_run_at'
    );
  });

  it('does not grant prepared-field trust to a second payload that reuses params', async () => {
    const service = new SchedulesService(null as never);
    const params = {};
    const firstPayload = { name: 'first payload' };
    markWriteDataPrepared()({ data: firstPayload, params } as never);

    await expect(
      service.create(
        {
          branch_id: '00000000-0000-7000-8000-000000000001',
          name: 'Nightly',
          cron_expression: '0 0 * * *',
          timezone_mode: 'utc',
          prompt: 'Run',
          agentic_tool_config: { agentic_tool: 'codex' },
          next_run_at: 456,
        } as never,
        params as never
      )
    ).rejects.toThrow('Schedule contains unsupported write fields: next_run_at');
  });

  it.each([
    ['id', 'caller-supplied-id'],
    ['channel_key', 'caller-supplied-secret'],
    ['created_at', '2026-07-28T00:00:00.000Z'],
    ['last_message_at', '2026-07-28T00:00:00.000Z'],
  ])('rejects runtime-owned gateway create field %s', async (field, value) => {
    const service = new GatewayChannelsService(null as never);

    await expect(
      service.create({
        name: 'Engineering',
        channel_type: 'slack',
        target_branch_id: '00000000-0000-7000-8000-000000000001',
        config: {},
        enabled: false,
        [field]: value,
      } as never)
    ).rejects.toThrow(`Gateway channel contains unsupported write fields: ${field}`);
  });

  it('rejects runtime-owned gateway activity on direct patch', async () => {
    const service = new GatewayChannelsService(null as never);
    await expect(
      service.patch('gateway-id', { last_message_at: '2026-07-28T00:00:00.000Z' } as never)
    ).rejects.toThrow('Gateway channel contains unsupported write fields: last_message_at');
  });
});
