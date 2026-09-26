import type { AgorClient } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEnvironmentStart } from './useEnvironmentStart';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('../utils/modal', () => ({ useThemedModal: () => ({ confirm }) }));
afterEach(() => vi.resetAllMocks());
describe('Start recovery consent', () => {
  function harness(failed = true) {
    const get = vi.fn(async () => ({
      environment_instance: failed
        ? {
            command_attempt: { id: 'current', finished_at: 'done' },
            last_command: { status: 'unknown' },
          }
        : { status: 'stopped' },
    }));
    const create = vi.fn();
    const service = vi.fn((path: string) => (path === 'branches' ? { get } : { create }));
    const { result } = renderHook(() => useEnvironmentStart({ service } as unknown as AgorClient));
    return { start: result.current, create, get };
  }
  it('cancellation never dispatches a command', async () => {
    confirm.mockImplementation((options) => options.onCancel());
    const h = harness();
    expect(await h.start('branch')).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('requires explicit warning acceptance and binds consent to the freshly fetched attempt', async () => {
    confirm.mockImplementation((options) => {
      expect(options.content).toContain('incurring charges');
      options.onOk();
    });
    const h = harness();
    expect(await h.start('branch')).toBe(true);
    expect(h.get).toHaveBeenCalledWith('branch');
    expect(h.create).toHaveBeenCalledWith({ confirmation_of: 'current' });
  });
  it('does not add sticky consent after successful cleanup, and surfaces server-side stale rejection', async () => {
    const clean = harness(false);
    await clean.start('branch');
    expect(confirm).not.toHaveBeenCalled();
    expect(clean.create).toHaveBeenCalledWith({});
    const stale = harness();
    confirm.mockImplementation((options) => options.onOk());
    stale.create.mockRejectedValueOnce(new Error('cleanup is unconfirmed'));
    await expect(stale.start('branch')).rejects.toThrow('cleanup is unconfirmed');
    expect(stale.create).toHaveBeenCalledTimes(1);
  });
});
