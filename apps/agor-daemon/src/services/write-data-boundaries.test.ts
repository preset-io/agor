import { describe, expect, it } from 'vitest';
import { markWriteDataPrepared } from '../utils/write-data-boundary.js';
import { GatewayChannelsService } from './gateway-channels.js';
import { SchedulesService } from './schedules.js';

describe('runtime write-data boundaries', () => {
  it.each([
    ['schedule_id', 'caller-supplied-id'],
    ['last_run_at', 123],
    ['last_run_session_id', 'caller-supplied-session'],
    ['next_run_at', 456],
    ['created_at', '2026-07-28T00:00:00.000Z'],
    ['tenant_id', 'caller-supplied-tenant'],
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
    ['tenant_id', 'caller-supplied-tenant'],
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
