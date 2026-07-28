import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  assertServiceWriteFields,
  enforcePublicWriteFields,
  markWriteDataPrepared,
} from '../utils/write-data-boundary.js';
import { GatewayChannelsService } from './gateway-channels.js';
import { SchedulesService } from './schedules.js';

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

  // Regression: in multi-tenant (Postgres) mode the tenant scoping hook stamps
  // `tenant_id` onto every tenant-owned create before the schedules service's
  // public-write allowlist runs. `tenant_id` is server-managed (re-applied by
  // the DB layer from ambient tenant context), so the write boundary must not
  // reject it — otherwise creating any schedule from the UI fails with
  // "Schedule contains unsupported write fields: tenant_id".
  it('does not reject the server-managed tenant_id on schedule create', async () => {
    const service = new SchedulesService(null as never);

    // Reaches config normalization (which needs a real db) rather than being
    // rejected up front as an unsupported write field.
    await expect(
      service.create({
        branch_id: '00000000-0000-7000-8000-000000000001',
        name: 'Nightly',
        cron_expression: '0 0 * * *',
        timezone_mode: 'utc',
        prompt: 'Run',
        agentic_tool_config: { agentic_tool: 'codex' },
        tenant_id: 'tenant-a',
      } as never)
    ).rejects.not.toThrow('unsupported write fields');
  });

  it('does not reject the server-managed tenant_id on gateway create', async () => {
    const service = new GatewayChannelsService(null as never);

    await expect(
      service.create({
        name: 'Engineering',
        channel_type: 'slack',
        target_branch_id: '00000000-0000-7000-8000-000000000001',
        config: {},
        enabled: false,
        tenant_id: 'tenant-a',
      } as never)
    ).rejects.not.toThrow('unsupported write fields');
  });

  it('treats tenant_id as server-managed across both write-boundary gates', () => {
    // Public before-hook gate: a stamped tenant_id passes, an unknown field fails.
    expect(() =>
      enforcePublicWriteFields('Schedule', ['name'])({
        data: { name: 'ok', tenant_id: 'tenant-a' },
      } as HookContext)
    ).not.toThrow();
    expect(() =>
      enforcePublicWriteFields('Schedule', ['name'])({
        data: { name: 'ok', bogus: 1 },
      } as HookContext)
    ).toThrow('unsupported write fields: bogus');

    // Direct service-consumer gate: same treatment without prepared trust.
    expect(() =>
      assertServiceWriteFields('Schedule', { name: 'ok', tenant_id: 'tenant-a' }, ['name'])
    ).not.toThrow();
    expect(() => assertServiceWriteFields('Schedule', { name: 'ok', bogus: 1 }, ['name'])).toThrow(
      'unsupported write fields: bogus'
    );
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
