import type { Session, Task } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { resolvePromptOrigin } from './prompt-origin.js';

const task = (metadata: Task['metadata']): Pick<Task, 'metadata'> => ({ metadata });
const session = (channelType?: string): Pick<Session, 'custom_context'> => ({
  custom_context: channelType
    ? {
        gateway_source: {
          channel_id: 'channel-1',
          channel_name: 'agents',
          channel_type: channelType,
          thread_id: 'thread-1',
        },
      }
    : undefined,
});

describe('resolvePromptOrigin', () => {
  it('trusts a direct Agor prompt as human', () => {
    expect(resolvePromptOrigin(task({ source: 'agor' }), session())).toEqual({ kind: 'human' });
  });

  it('maps gateway provenance through the trusted Session channel type', () => {
    expect(resolvePromptOrigin(task({ source: 'gateway' }), session('slack'))).toEqual({
      kind: 'channel',
      server: 'slack',
    });
  });

  it('fails closed when gateway Session metadata is missing', () => {
    expect(resolvePromptOrigin(task({ source: 'gateway' }), session())).toBeUndefined();
  });

  it.each([
    { source: 'agor' as const, is_agor_callback: true },
    { source: 'agor' as const, system_authored: true },
    undefined,
  ])('leaves synthesized or unattributed prompts unattributed (%j)', (metadata) => {
    expect(resolvePromptOrigin(task(metadata), session())).toBeUndefined();
  });
});
