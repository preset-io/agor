import { beforeEach, describe, expect, it, vi } from 'vitest';

const containment = vi.hoisted(() => ({
  release: vi.fn(),
  reserve: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../../executor-tracking.js', () => ({
  releaseExecutorContainmentFenceIntent: containment.release,
  reserveExecutorContainmentFence: containment.reserve,
  verifyExecutorContainmentFence: containment.verify,
}));

import {
  blockOpenCodeNativeStateNamespace,
  inOpenCodeNativeStateMutationSlot,
  type OpenCodeNativeStateMutationFence,
} from './native-state-coordinator.js';

function attachedMutation<T>(result: T, retain = vi.fn(async () => undefined)) {
  return {
    retain,
    work: vi.fn(async (fence: OpenCodeNativeStateMutationFence) => {
      await fence.attach({ retainContainmentFence: retain, verifyAbsence: async () => true });
      return result;
    }),
  };
}

beforeEach(() => {
  containment.release.mockReset().mockResolvedValue(undefined);
  containment.reserve.mockReset().mockResolvedValue('intent-1');
  containment.verify.mockReset().mockResolvedValue(true);
});

describe('OpenCode native-state coordinator', () => {
  it('keeps persistence failures public-safe and fenced in memory', async () => {
    const key = crypto.randomUUID();
    const verifyAbsence = vi.fn(async () => true);
    const failure = await blockOpenCodeNativeStateNamespace(key, {
      retainContainmentFence: vi.fn(async () => {
        throw new Error('secret /private/fence-path');
      }),
      verifyAbsence,
    }).catch((error) => error);

    expect(String(failure)).toMatch(/cleanup could not be verified/i);
    expect(String(failure)).not.toContain('/private/fence-path');
    const { work } = attachedMutation('recovered');
    await expect(inOpenCodeNativeStateMutationSlot(key, work)).resolves.toBe('recovered');
    expect(verifyAbsence).toHaveBeenCalledOnce();
  });

  it('retains every unverified cleanup fence before allowing another mutation', async () => {
    const key = crypto.randomUUID();
    const first = vi.fn(async () => true);
    const second = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const retainFirst = vi.fn(async () => undefined);
    const retainSecond = vi.fn(async () => undefined);
    await blockOpenCodeNativeStateNamespace(key, {
      retainContainmentFence: retainFirst,
      verifyAbsence: first,
    });
    await blockOpenCodeNativeStateNamespace(key, {
      retainContainmentFence: retainSecond,
      verifyAbsence: second,
    });

    expect(retainFirst).toHaveBeenCalledOnce();
    expect(retainSecond).toHaveBeenCalledOnce();

    const mutation = attachedMutation('mutated');
    await expect(inOpenCodeNativeStateMutationSlot(key, mutation.work)).rejects.toThrow(
      /mutations remain blocked/i
    );
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(mutation.work).not.toHaveBeenCalled();

    await expect(inOpenCodeNativeStateMutationSlot(key, mutation.work)).resolves.toBe('mutated');
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    expect(mutation.work).toHaveBeenCalledOnce();
  });

  it('persists a start intent before work and replaces it only after writer identity is durable', async () => {
    const events: string[] = [];
    containment.reserve.mockImplementation(async () => {
      events.push('intent-durable');
      return 'intent-2';
    });
    containment.release.mockImplementation(async () => {
      events.push('intent-released');
    });
    const retain = vi.fn(async () => {
      events.push('identity-durable');
    });

    await inOpenCodeNativeStateMutationSlot(crypto.randomUUID(), async (fence) => {
      events.push('work-started');
      await fence.attach({ retainContainmentFence: retain, verifyAbsence: async () => true });
      events.push('attached');
    });

    expect(events).toEqual([
      'intent-durable',
      'work-started',
      'identity-durable',
      'intent-released',
      'attached',
    ]);
  });

  it('leaves the durable intent in place when writer identity cannot be retained', async () => {
    const key = crypto.randomUUID();
    const retain = vi.fn(async () => {
      throw new Error('secret persistence failure');
    });

    await expect(
      inOpenCodeNativeStateMutationSlot(key, async (fence) => {
        await fence.attach({ retainContainmentFence: retain, verifyAbsence: async () => true });
      })
    ).rejects.toThrow(/cleanup could not be verified/i);
    expect(containment.release).not.toHaveBeenCalled();
  });
});
