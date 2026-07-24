import type { ScheduleAgenticToolConfig } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildModelConfigFromFormValues,
  buildScheduleConfigFromFormValues,
} from './agenticConfigHelpers';

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
