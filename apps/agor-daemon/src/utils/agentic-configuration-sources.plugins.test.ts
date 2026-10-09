import {
  type materializeAgenticToolConfiguration,
  normalizeScheduleAgenticToolConfig,
} from '@agor/core/config';
import { resolveSessionDefaults } from '@agor/core/sessions';
import { describe, expect, it } from 'vitest';
import {
  gatewayAgenticConfigToInlineConfiguration,
  materializedAgenticToolConfigurationToGatewayConfig,
  materializedAgenticToolConfigurationToScheduleConfig,
  scheduleAgenticToolConfigToSource,
} from './agentic-configuration-sources';

describe('plugin preference in schedule/gateway configuration', () => {
  it.each([undefined, false, true])(
    'round-trips preference %s without losing explicit false',
    (codexIncludePlugins) => {
      const permission_config = resolveSessionDefaults({
        agenticTool: 'codex',
        overrides: { codexIncludePlugins },
      }).permission_config;
      const materialized: Awaited<ReturnType<typeof materializeAgenticToolConfiguration>> = {
        agentic_tool_preset_id: null,
        permission_config,
        model_config: undefined,
      };
      const schedule = materializedAgenticToolConfigurationToScheduleConfig(
        { agentic_tool: 'codex' },
        materialized
      );
      const normalized = normalizeScheduleAgenticToolConfig(schedule);
      expect(scheduleAgenticToolConfigToSource(normalized).configuration?.codexIncludePlugins).toBe(
        codexIncludePlugins ?? false
      );
      const gateway = materializedAgenticToolConfigurationToGatewayConfig(
        { agent: 'codex' },
        materialized
      );
      expect(gatewayAgenticConfigToInlineConfiguration(gateway).codexIncludePlugins).toBe(
        codexIncludePlugins ?? false
      );
    }
  );
});
