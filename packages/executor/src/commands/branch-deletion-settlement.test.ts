import { BRANCH_DELETION_ACTION_EFFECTS } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchDeletePayload } from '../payload-types';
import { handleBranchDelete } from './branch-deletion';

const storage = vi.hoisted(() => ({
  resolveManagedBranchDeletionPath: vi.fn().mockResolvedValue(undefined),
  removeBranchWorkspace: vi.fn().mockResolvedValue(undefined),
  deleteBranchDirectory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@agor/git', () => storage);

const id = '01900000-0000-7000-8000-000000000001';
const operationId = '01900000-0000-7000-8000-000000000002';
const executionId = '01900000-0000-7000-8000-000000000003';
const payload: BranchDeletePayload = {
  command: 'branch.delete',
  daemonUrl: 'https://daemon.invalid',
  sessionToken: 'fixture-token',
  params: {
    branchId: id,
    operationId,
    generation: 7,
    executionId,
    branchPath: '/fixture/worktrees/victim',
    branchesRoot: '/fixture/worktrees',
    repoPath: '/fixture/repos/base',
    branchHome: `/fixture/branch-homes/${id}`,
    tenantDataRoot: '/fixture',
    storageMode: 'clone',
  },
};

function fixture(
  settlement: (request: RequestInit) => Promise<Response>,
  failedAction = 'data',
  status = 500
) {
  const actions: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, request: RequestInit) => {
      const body = JSON.parse(String(request.body));
      expect(request.headers).toMatchObject({ Authorization: 'Bearer fixture-token' });
      expect(body).toMatchObject({
        branch_id: id,
        operation_id: operationId,
        generation: 7,
        execution_id: executionId,
      });
      actions.push(body.action);
      if (body.action === 'settled') return settlement(request);
      if (body.action === failedAction) return new Response('{}', { status });
      return Response.json({ ok: true, remaining: false });
    })
  );
  return actions;
}

function expectNoDestructiveReplay(actions: string[]) {
  expect(actions.filter((action) => action !== 'settled')).toEqual([
    'claim',
    'quiesce',
    'upload',
    'storage',
    'data',
  ]);
  expect(storage.removeBranchWorkspace).toHaveBeenCalledTimes(1);
  expect(storage.deleteBranchDirectory).toHaveBeenCalledTimes(1);
}

describe('exact branch settlement delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('survives a brief outage rather than exhausting immediate attempts', async () => {
    let owned = true;
    const times: number[] = [];
    const actions = fixture(async () => {
      times.push(Date.now());
      if (Date.now() < 1_500) throw new Error('offline');
      owned = false;
      return Response.json({ ok: true });
    });
    const result = handleBranchDelete(payload, {});
    await vi.advanceTimersByTimeAsync(1_499);
    expect(owned).toBe(true);
    await vi.runAllTimersAsync();
    expect((await result).success).toBe(false); // Delivery is not successful deletion.
    expect(owned).toBe(false);
    expect(times).toEqual([0, 250, 750, 1_750]);
    expectNoDestructiveReplay(actions);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['transport', 'http', 'hung_request', 'hung_body'] as const)(
    'bounds %s failure by the deadline without releasing ownership or replaying work',
    async (mode) => {
      const times: number[] = [];
      const abortedAt: number[] = [];
      const actions = fixture(async (request) => {
        times.push(Date.now());
        request.signal!.addEventListener('abort', () => abortedAt.push(Date.now()), { once: true });
        if (mode === 'http') return new Response('{}', { status: 503 });
        if (mode === 'hung_request') return new Promise<Response>(() => {});
        if (mode === 'hung_body')
          return {
            ok: true,
            status: 200,
            json: () =>
              new Promise((_, reject) => {
                request.signal!.addEventListener('abort', () => reject(request.signal!.reason), {
                  once: true,
                });
              }),
          } as Response;
        throw new Error('offline');
      });
      const result = handleBranchDelete(payload, {});
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await result).success).toBe(false);
      expect(times.length).toBeGreaterThan(3);
      expect(times.every((time) => time < 15_000)).toBe(true);
      if (mode === 'hung_body' || mode === 'hung_request') {
        expect(abortedAt).toHaveLength(times.length);
        expect(abortedAt[0]).toBe(2_000);
        expect(abortedAt.at(-1)).toBe(15_000);
        expect(abortedAt.every((time, index) => time - times[index]! <= 2_000)).toBe(true);
      }
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('event=settlement_exhausted')
      );
      expectNoDestructiveReplay(actions);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([408, 429])('retries transient HTTP %s within the same scope', async (status) => {
    let attempts = 0;
    const actions = fixture(async () =>
      ++attempts === 1 ? new Response('{}', { status }) : Response.json({ ok: true })
    );
    const result = handleBranchDelete(payload, {});
    await vi.runAllTimersAsync();
    await result;
    expect(attempts).toBe(2);
    expectNoDestructiveReplay(actions);
  });

  it.each([400, 401, 403, 404, 409])('stops on definitive HTTP %s rejection', async (status) => {
    const actions = fixture(async () => new Response('{}', { status }));
    const result = handleBranchDelete(payload, {});
    await vi.runAllTimersAsync();
    await result;
    expect(actions.filter((action) => action === 'settled')).toHaveLength(1);
    expectNoDestructiveReplay(actions);
  });

  it('does not treat a lost committed response followed by changed ownership as acceptance', async () => {
    let owner = 'original';
    const actions = fixture(async () => {
      if (owner === 'original') {
        owner = 'replacement'; // Settlement committed, authorized replacement admitted.
        throw new Error('committed response lost');
      }
      return new Response('{}', { status: 409 });
    });
    const result = handleBranchDelete(payload, {});
    await vi.runAllTimersAsync();
    await result;
    expect(owner).toBe('replacement');
    expect(actions.filter((action) => action === 'settled')).toHaveLength(2);
    expect(console.info).not.toHaveBeenCalledWith(expect.stringContaining('action=settled'));
    expectNoDestructiveReplay(actions);
  });

  it.each([400, 500])('keeps the external-IO action fenced even for HTTP %s', async (status) => {
    expect(BRANCH_DELETION_ACTION_EFFECTS.upload).toBe('external_io');
    const actions = fixture(
      async () => {
        throw new Error('must not settle');
      },
      'upload',
      status
    );
    const result = handleBranchDelete(payload, {});
    await vi.runAllTimersAsync();
    await result;
    expect(actions).toEqual(['claim', 'quiesce', 'upload']);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('category=storage_request_unsettled')
    );
  });
});
