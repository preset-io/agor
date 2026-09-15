import { describe, expect, it, vi } from 'vitest';
import { type RotatingGrantAdapter, refreshRotatingGrant } from './rotating-grant-refresh';

function adapter(): RotatingGrantAdapter<string, string, string> {
  return {
    claim: vi.fn(async () => ({ owned: true as const, claim: 'exact-fence' })),
    prepare: vi.fn(async () => {}),
    exchange: vi.fn(async () => 'rotated-pair'),
    commit: vi.fn(async () => true),
    deliver: vi.fn(async () => 'access-only'),
    observe: vi.fn(async () => 'observed-access'),
    recoverCommitted: vi.fn(async () => null),
    classify: vi.fn(() => 'ambiguous' as const),
    settle: vi.fn(async () => {}),
  };
}

describe('shared rotating grant protocol', () => {
  it('recovers a lost commit acknowledgement without settlement or replay', async () => {
    const a = adapter();
    vi.mocked(a.commit).mockRejectedValue(new Error('lost acknowledgement'));
    vi.mocked(a.recoverCommitted).mockResolvedValue({ value: 'proven-access' });
    await expect(refreshRotatingGrant(a)).resolves.toBe('proven-access');
    expect(a.exchange).toHaveBeenCalledTimes(1);
    expect(a.settle).not.toHaveBeenCalled();
  });
  it('releases known pre-dispatch cancellation without exchange', async () => {
    const a = adapter();
    const error = new Error('task revoked');
    vi.mocked(a.prepare).mockRejectedValue(error);
    await expect(refreshRotatingGrant(a)).rejects.toBe(error);
    expect(a.settle).toHaveBeenCalledWith('exact-fence', 'cancelled', error);
    expect(a.exchange).not.toHaveBeenCalled();
  });
  it('settles an uncertain exchange once and never retries', async () => {
    const a = adapter();
    const error = new Error('response lost');
    vi.mocked(a.exchange).mockRejectedValue(error);
    await expect(refreshRotatingGrant(a)).rejects.toBe(error);
    expect(a.settle).toHaveBeenCalledWith('exact-fence', 'ambiguous', error);
    expect(a.exchange).toHaveBeenCalledTimes(1);
  });
  it('does not corrupt a successful rotation when final delivery is denied', async () => {
    const a = adapter();
    vi.mocked(a.deliver).mockRejectedValue(new Error('task stopped'));
    await expect(refreshRotatingGrant(a)).rejects.toThrow('task stopped');
    expect(a.settle).not.toHaveBeenCalled();
    expect(a.recoverCommitted).not.toHaveBeenCalled();
  });
  it('observers never dispatch the token claimed by another client', async () => {
    const a = adapter();
    vi.mocked(a.claim).mockResolvedValue({ owned: false, observe: async () => 'winner-access' });
    await expect(refreshRotatingGrant(a)).resolves.toBe('winner-access');
    expect(a.exchange).not.toHaveBeenCalled();
    expect(a.prepare).not.toHaveBeenCalled();
  });
  it('does not assume success from an unsuccessful commit CAS', async () => {
    const a = adapter();
    vi.mocked(a.commit).mockResolvedValue(false);
    await expect(refreshRotatingGrant(a)).resolves.toBe('observed-access');
    expect(a.deliver).not.toHaveBeenCalled();
  });
});
