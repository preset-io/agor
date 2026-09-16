import type { AgorClient } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refetchMCPOAuthDurableState, waitForMCPOAuthAttempt } from '../../utils/mcpOAuthAttempt';
import { completeManagedOAuthReturn } from './managedOAuthReturn';

vi.mock('../../utils/mcpOAuthAttempt', () => ({
  refetchMCPOAuthDurableState: vi.fn(),
  waitForMCPOAuthAttempt: vi.fn(),
}));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.mocked(waitForMCPOAuthAttempt).mockResolvedValue({
    status: 'succeeded',
    mcp_server_id: 'server',
  } as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
const returned = {
  ticket: 'f'.repeat(43),
  flow: {
    nonce: '00000000-0000-4000-8000-000000000001',
    userId: 'caller',
    serverId: 'server',
    attemptId: 'attempt',
    transactionId: 'transaction',
    createdAt: 0,
  },
};
function api() {
  const create = vi.fn(async () => ({ accepted: true, attempt_id: 'attempt' }));
  return { create, client: { service: () => ({ create }) } as unknown as AgorClient };
}
describe('bounded durable return projection', () => {
  it('ends an unresponsive read within 45s and fences late application', async () => {
    const a = api();
    vi.mocked(refetchMCPOAuthDurableState).mockImplementation(() => new Promise(() => {}));
    const result = completeManagedOAuthReturn(
      a.client,
      returned,
      () => true,
      new AbortController().signal
    );
    const rejected = expect(result).rejects.toThrow('cannot be verified');
    await vi.advanceTimersByTimeAsync(45_001);
    await rejected;
    expect(a.create).toHaveBeenCalledOnce();
    const canApply = vi.mocked(refetchMCPOAuthDurableState).mock.calls[0][2];
    expect(canApply()).toBe(false);
  });
  it('aborts an unresponsive read without replaying the accepted ticket', async () => {
    const a = api();
    const controller = new AbortController();
    vi.mocked(refetchMCPOAuthDurableState).mockImplementation(() => new Promise(() => {}));
    const result = completeManagedOAuthReturn(a.client, returned, () => true, controller.signal);
    const rejected = expect(result).rejects.toThrow('cannot be verified');
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    expect(a.create).toHaveBeenCalledOnce();
    expect(vi.mocked(refetchMCPOAuthDurableState).mock.calls[0][2]()).toBe(false);
  });
});
