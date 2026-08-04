import { describe, expect, it, vi } from 'vitest';
import {
  blockOpenCodeNativeStateNamespace,
  inOpenCodeNativeStateMutationSlot,
} from './native-state-coordinator.js';

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
    await expect(inOpenCodeNativeStateMutationSlot(key, async () => 'recovered')).resolves.toBe(
      'recovered'
    );
    expect(verifyAbsence).toHaveBeenCalledOnce();
  });

  it('retains every unverified cleanup fence before allowing another mutation', async () => {
    const key = crypto.randomUUID();
    const first = vi.fn(async () => true);
    const second = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const mutation = vi.fn(async () => 'mutated');
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

    await expect(inOpenCodeNativeStateMutationSlot(key, mutation)).rejects.toThrow(
      /mutations remain blocked/i
    );
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(mutation).not.toHaveBeenCalled();

    await expect(inOpenCodeNativeStateMutationSlot(key, mutation)).resolves.toBe('mutated');
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    expect(mutation).toHaveBeenCalledOnce();
  });
});
