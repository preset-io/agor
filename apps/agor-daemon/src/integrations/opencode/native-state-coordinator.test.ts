import { describe, expect, it, vi } from 'vitest';
import {
  blockOpenCodeNativeStateNamespace,
  inOpenCodeNativeStateMutationSlot,
} from './native-state-coordinator.js';

describe('OpenCode native-state coordinator', () => {
  it('retains every unverified cleanup fence before allowing another mutation', async () => {
    const key = crypto.randomUUID();
    const first = vi.fn(async () => true);
    const second = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const mutation = vi.fn(async () => 'mutated');
    blockOpenCodeNativeStateNamespace(key, first);
    blockOpenCodeNativeStateNamespace(key, second);

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
