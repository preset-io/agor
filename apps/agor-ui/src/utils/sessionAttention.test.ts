import type { AgorClient, Branch, Session } from '@agor-live/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionMaps, EMPTY_MAPS } from '../store/agorMaps';
import { agorStore } from '../store/agorStore';
import { clearOpenedSessionFlags } from './sessionAttention';

const session = (id: string, extra: Partial<Session> = {}) =>
  ({ session_id: id, branch_id: 'b1', ready_for_prompt: false, ...extra }) as Session;

function clientSpy() {
  const patches: [string, string, unknown][] = [];
  const client = {
    service: (name: string) => ({
      patch: vi.fn(async (id: string, data: unknown) => {
        patches.push([name, id, data]);
      }),
    }),
  } as unknown as AgorClient;
  return { client, patches };
}

afterEach(() => agorStore.getState().reset());

describe('clearOpenedSessionFlags', () => {
  it('clears an unopened result and its branch attention', () => {
    agorStore.setState({
      ...EMPTY_MAPS,
      ...buildSessionMaps([session('done', { ready_for_prompt: true })]),
      branchById: new Map([['b1', { branch_id: 'b1', needs_attention: true } as Branch]]),
    } as never);
    const { client, patches } = clientSpy();
    clearOpenedSessionFlags(client, 'done');
    expect(patches).toEqual([
      ['sessions', 'done', { ready_for_prompt: false }],
      ['branches', 'b1', { needs_attention: false }],
    ]);
  });

  it('writes nothing when nothing is flagged', () => {
    agorStore.setState({ ...EMPTY_MAPS, ...buildSessionMaps([session('seen')]) } as never);
    const { client, patches } = clientSpy();
    clearOpenedSessionFlags(client, 'seen');
    clearOpenedSessionFlags(client, 'unknown');
    expect(patches).toEqual([]);
  });
});
