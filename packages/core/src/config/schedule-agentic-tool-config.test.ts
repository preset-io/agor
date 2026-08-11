import { describe, expect, it } from 'vitest';
import type { PersistedScheduleAgenticToolConfig, ScheduleAgenticToolConfig } from '../types';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '../types';
import {
  InvalidScheduleAgenticToolConfigError,
  normalizePersistedScheduleAgenticToolConfig,
  normalizeScheduleAgenticToolConfig,
} from './schedule-agentic-tool-config';

const LEGACY_WORKSPACE_DEFAULT = '___workspace_default___';

describe('normalizePersistedScheduleAgenticToolConfig', () => {
  it.each([
    [USER_DEFAULT_AGENTIC_CONFIGURATION, USER_DEFAULT_AGENTIC_CONFIGURATION, undefined],
    [WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION, undefined],
    [LEGACY_WORKSPACE_DEFAULT, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION, undefined],
    [
      LEGACY_WORKSPACE_DEFAULT,
      USER_DEFAULT_AGENTIC_CONFIGURATION,
      USER_DEFAULT_AGENTIC_CONFIGURATION,
    ],
  ] as const)(
    'canonicalizes stored preset reference %s without dropping its snapshot',
    (presetId, expected, canonical) => {
      const normalized = normalizePersistedScheduleAgenticToolConfig({
        agentic_tool: 'codex',
        preset_id: presetId as ScheduleAgenticToolConfig['preset_id'],
        ...(canonical ? { configuration_reference: canonical } : {}),
        context_files: ['AGENTS.md'],
        model_config: { mode: 'exact', model: 'gpt-5.4' },
      });
      expect(normalized).toEqual({
        agentic_tool: 'codex',
        configuration_reference: expected,
        context_files: ['AGENTS.md'],
        model_config: { mode: 'exact', model: 'gpt-5.4' },
      });
    }
  );
});

describe('normalizeScheduleAgenticToolConfig', () => {
  it('rejects removed runtime identifiers preserved in historical rows', () => {
    expect(() =>
      normalizeScheduleAgenticToolConfig({
        agentic_tool: 'claude-code-cli',
        permission_mode: 'auto',
      })
    ).toThrow(/removed or unsupported schedule agentic tool/i);
  });

  it.each([
    [USER_DEFAULT_AGENTIC_CONFIGURATION, USER_DEFAULT_AGENTIC_CONFIGURATION],
    [WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION],
    [LEGACY_WORKSPACE_DEFAULT, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION],
  ])('canonicalizes reserved preset reference %s', (input, expected) => {
    expect(
      normalizeScheduleAgenticToolConfig({
        agentic_tool: 'codex',
        preset_id: input as ScheduleAgenticToolConfig['preset_id'],
      })
    ).toEqual({
      agentic_tool: 'codex',
      configuration_reference: expected,
    });
  });

  it('rejects mixed default-reference and inline configuration', () => {
    expect(() =>
      normalizeScheduleAgenticToolConfig({
        agentic_tool: 'codex',
        configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
        model_config: { mode: 'exact', model: 'gpt-5.4' },
      })
    ).toThrow(InvalidScheduleAgenticToolConfigError);
  });

  it.each([
    [
      'preset plus inline',
      {
        agentic_tool: 'codex',
        preset_id: '00000000-0000-7000-8000-000000000001',
        model_config: { mode: 'exact', model: 'gpt-5.4' },
      },
    ],
    [
      'reference plus preset',
      {
        agentic_tool: 'codex',
        configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
        preset_id: '00000000-0000-7000-8000-000000000001',
      },
    ],
    [
      'reference, preset, and inline',
      {
        agentic_tool: 'codex',
        configuration_reference: USER_DEFAULT_AGENTIC_CONFIGURATION,
        preset_id: '00000000-0000-7000-8000-000000000001',
        permission_mode: 'auto',
      },
    ],
  ])('rejects %s sources', (_label, config) => {
    expect(() =>
      normalizeScheduleAgenticToolConfig(config as PersistedScheduleAgenticToolConfig)
    ).toThrow(InvalidScheduleAgenticToolConfigError);
  });

  it('rejects an unknown configuration reference', () => {
    expect(() =>
      normalizeScheduleAgenticToolConfig({
        agentic_tool: 'codex',
        configuration_reference:
          '__not_a_default__' as ScheduleAgenticToolConfig['configuration_reference'],
      })
    ).toThrow(/invalid default configuration reference/i);
  });

  it('ignores undefined inline fields when classifying a preset source', () => {
    expect(
      normalizeScheduleAgenticToolConfig({
        agentic_tool: 'codex',
        preset_id: '00000000-0000-7000-8000-000000000001' as ScheduleAgenticToolConfig['preset_id'],
        model_config: undefined,
        codex_network_access: undefined,
      })
    ).toEqual({
      agentic_tool: 'codex',
      preset_id: '00000000-0000-7000-8000-000000000001',
      model_config: undefined,
      codex_network_access: undefined,
    });
  });
});
