import type { ScheduleAgenticToolConfig } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildConfigFromFormValues,
  buildModelConfigFromFormValues,
  buildScheduleConfigFromFormValues,
  getFormValuesFromConfig,
} from './agenticConfigHelpers';

describe('getFormValuesFromConfig', () => {
  it('explicitly clears merged model fields when a tool has no stored config', () => {
    const values = getFormValuesFromConfig('codex');

    expect(values).toHaveProperty('modelConfig', undefined);
    expect(values).toHaveProperty('effort', undefined);
  });
});

describe('buildModelConfigFromFormValues', () => {
  it('stores an explicit effort beside the selected model', () => {
    expect(
      buildModelConfigFromFormValues({
        modelConfig: { model: 'gpt-5.6-sol' },
        effort: 'medium',
      })
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' });
  });

  it('removes a stale nested effort when the form returns to inherited', () => {
    expect(
      buildModelConfigFromFormValues({
        modelConfig: { model: 'gpt-5.6-sol', effort: 'high' },
        effort: undefined,
      })
    ).toEqual({ model: 'gpt-5.6-sol' });
  });
});

describe('buildScheduleConfigFromFormValues', () => {
  it('detaches a previous preset when switching a schedule to inline configuration', () => {
    const previous = {
      agentic_tool: 'claude-code',
      preset_id: 'preset-1',
      context_files: ['AGENTS.md'],
    } as ScheduleAgenticToolConfig;

    const result = buildScheduleConfigFromFormValues(
      'claude-code',
      { permissionMode: 'default', modelConfig: { model: 'claude-sonnet-4-6' } },
      previous
    );

    expect(result).toMatchObject({
      agentic_tool: 'claude-code',
      permission_mode: 'default',
      context_files: ['AGENTS.md'],
    });
    expect(result.preset_id).toBeUndefined();
  });

  it('detaches a previous default reference when switching to inline configuration', () => {
    const previous = {
      agentic_tool: 'codex',
      configuration_reference: '__user_default__',
      context_files: ['AGENTS.md'],
    } as ScheduleAgenticToolConfig;

    const result = buildScheduleConfigFromFormValues(
      'codex',
      { permissionMode: 'default', modelConfig: { model: 'gpt-5.4' } },
      previous
    );

    expect(result.configuration_reference).toBeUndefined();
    expect(result.preset_id).toBeUndefined();
    expect(result.context_files).toEqual(['AGENTS.md']);
  });
});

describe('buildConfigFromFormValues', () => {
  it('rejects a cleared OpenCode provider/model pair before persistence', () => {
    expect(() =>
      buildConfigFromFormValues('opencode', {
        modelConfig: undefined,
        effort: 'high',
        permissionMode: 'default',
      })
    ).toThrow(/select.*provider.*model/i);
  });

  it('rejects a partial OpenCode provider/model pair before persistence', () => {
    expect(() =>
      buildConfigFromFormValues('opencode', {
        modelConfig: { mode: 'exact', provider: 'openai', model: '' },
        effort: 'high',
        permissionMode: 'default',
      })
    ).toThrow(/select.*provider.*model/i);
  });

  it('preserves a complete exact OpenCode provider/model pair', () => {
    const result = buildConfigFromFormValues('opencode', {
      modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-5' },
      effort: 'high',
      permissionMode: 'default',
    });

    expect(result.modelConfig).toEqual({
      mode: 'exact',
      provider: 'openai',
      model: 'gpt-5',
      effort: 'high',
    });
  });
});
