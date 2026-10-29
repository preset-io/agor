import type { TaskAnalyticsOrigin, TaskMetadata } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { classifyTaskAuthorship } from './task-authorship';

const provenance = { version: 1 } as unknown as NonNullable<TaskMetadata['prompt_provenance']>;

describe('classifyTaskAuthorship', () => {
  it.each<[string, TaskMetadata | undefined, TaskAnalyticsOrigin | undefined, string]>([
    ['UI/API prompt', { source: 'agor' }, undefined, 'human'],
    [
      'onboarding welcome prompt',
      { source: 'agor' },
      'onboarding_bootstrap',
      'onboarding_bootstrap',
    ],
    [
      'teammate-dialog first prompt',
      { source: 'agor' },
      'teammate_bootstrap',
      'teammate_bootstrap',
    ],
    [
      'child completion callback',
      { source: 'agor', is_agor_callback: true },
      undefined,
      'callback',
    ],
    [
      'widget auto-resume / zone trigger / MCP continuation',
      { source: 'agor', system_authored: true },
      undefined,
      'system',
    ],
    ['MCP-delivered prompt', { prompt_provenance: provenance }, undefined, 'agent'],
    ['gateway message', { source: 'gateway' }, undefined, 'gateway'],
    ['scheduler or other unattributed producer', {}, undefined, 'internal'],
    ['no metadata', undefined, undefined, 'internal'],
  ])('%s → %s', (_label, metadata, origin, expected) => {
    expect(classifyTaskAuthorship(metadata, origin)).toBe(expected);
  });

  it('never lets an onboarding origin or human source outrank a synthesized marker', () => {
    expect(
      classifyTaskAuthorship({ source: 'agor', system_authored: true }, 'onboarding_bootstrap')
    ).toBe('system');
  });
});
