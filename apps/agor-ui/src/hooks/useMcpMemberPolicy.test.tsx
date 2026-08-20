import type { AgorClient, MCPMemberPolicySetting } from '@agor-live/client';
import { MCP_MEMBER_POLICY_CHANGED_EVENT } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMcpMemberPolicy } from './useMcpMemberPolicy';

type Listener = () => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeClient(initial: MCPMemberPolicySetting) {
  const listeners = new Map<string, Listener[]>();
  const answers: Array<Promise<MCPMemberPolicySetting>> = [Promise.resolve(initial)];
  const find = vi.fn(() => answers.shift() ?? Promise.resolve(initial));
  const patch = vi.fn().mockResolvedValue({ policy: 'allow_crud' });
  const mcpServers = {
    on: (event: string, listener: Listener) =>
      listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    removeListener: (event: string, listener: Listener) =>
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
      ),
  };
  const client = {
    service: (path: string) => (path === 'mcp-member-policy' ? { find, patch } : mcpServers),
  } as unknown as AgorClient;
  return {
    client,
    find,
    patch,
    answerNext: (answer: Promise<MCPMemberPolicySetting>) => answers.push(answer),
    emitPolicyChange: () => {
      for (const listener of listeners.get(MCP_MEMBER_POLICY_CHANGED_EVENT) ?? []) listener();
    },
  };
}

const MEMBER = { user_id: 'member-1', role: 'member' } as const;
const OTHER_MEMBER = { user_id: 'member-2', role: 'member' } as const;

describe('useMcpMemberPolicy caller scope', () => {
  it('fails closed immediately on demotion and waits for new socket authority', async () => {
    const next = deferred<MCPMemberPolicySetting>();
    const seam = makeClient({ policy: 'allow_crud', can_configure: true });
    seam.answerNext(next.promise);
    const { result, rerender } = renderHook(
      ({ role, authGeneration }: { role: string; authGeneration: number }) =>
        useMcpMemberPolicy(seam.client, {
          connectionReady: true,
          currentUser: { ...MEMBER, role },
          authGeneration,
        }),
      { initialProps: { role: 'member', authGeneration: 1 } }
    );
    await waitFor(() => expect(result.current.canConfigure).toBe(true));

    rerender({ role: 'viewer', authGeneration: 1 });

    expect(result.current).toMatchObject({ canConfigure: false, loading: true });
    expect(seam.find).toHaveBeenCalledTimes(1);

    rerender({ role: 'viewer', authGeneration: 2 });
    expect(seam.find).toHaveBeenCalledTimes(2);
    await act(() => next.resolve({ policy: 'allow_crud', can_configure: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canConfigure).toBe(false);
  });

  it('does not issue a viewer-to-member policy read before socket reauthentication', async () => {
    const next = deferred<MCPMemberPolicySetting>();
    const seam = makeClient({ policy: 'allow_crud', can_configure: false });
    seam.answerNext(next.promise);
    const { result, rerender } = renderHook(
      ({ role, authGeneration }: { role: string; authGeneration: number }) =>
        useMcpMemberPolicy(seam.client, {
          connectionReady: true,
          currentUser: { ...MEMBER, role },
          authGeneration,
        }),
      { initialProps: { role: 'viewer', authGeneration: 1 } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canConfigure).toBe(false);

    rerender({ role: 'member', authGeneration: 1 });
    expect(result.current).toMatchObject({ canConfigure: false, loading: true });
    expect(seam.find).toHaveBeenCalledTimes(1);

    rerender({ role: 'member', authGeneration: 2 });
    expect(seam.find).toHaveBeenCalledTimes(2);
    await act(() => next.resolve({ policy: 'allow_crud', can_configure: true }));
    await waitFor(() => expect(result.current.canConfigure).toBe(true));
  });

  it('fails closed across identity and token-generation replacement on a stable client', async () => {
    const next = deferred<MCPMemberPolicySetting>();
    const seam = makeClient({ policy: 'allow_crud', can_configure: true });
    seam.answerNext(next.promise);
    const { result, rerender } = renderHook(
      ({ userId, authGeneration }: { userId: string; authGeneration: number }) =>
        useMcpMemberPolicy(seam.client, {
          connectionReady: true,
          currentUser: { ...OTHER_MEMBER, user_id: userId },
          authGeneration,
        }),
      { initialProps: { userId: MEMBER.user_id, authGeneration: 1 } }
    );
    await waitFor(() => expect(result.current.canConfigure).toBe(true));

    rerender({ userId: OTHER_MEMBER.user_id, authGeneration: 2 });

    expect(result.current).toMatchObject({ canConfigure: false, loading: true });
    expect(seam.find).toHaveBeenCalledTimes(2);
    await act(() => next.resolve({ policy: 'allow_private_only', can_configure: true }));
    await waitFor(() => expect(result.current.canConfigure).toBe(true));
  });

  it('eliminates the permissive disconnect window from render-time state', async () => {
    const seam = makeClient({ policy: 'allow_crud', can_configure: true });
    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useMcpMemberPolicy(seam.client, {
          connectionReady: ready,
          currentUser: MEMBER,
          authGeneration: 1,
        }),
      { initialProps: { ready: true } }
    );
    await waitFor(() => expect(result.current.canConfigure).toBe(true));

    rerender({ ready: false });

    expect(result.current).toMatchObject({
      canConfigure: false,
      loading: false,
      error: 'Not connected to the Agor daemon',
    });
  });

  it('invalidates on a tenant policy event and withholds until the refetch lands', async () => {
    const next = deferred<MCPMemberPolicySetting>();
    const seam = makeClient({ policy: 'allow_crud', can_configure: true });
    seam.answerNext(next.promise);
    const { result } = renderHook(() =>
      useMcpMemberPolicy(seam.client, {
        connectionReady: true,
        currentUser: MEMBER,
        authGeneration: 1,
      })
    );
    await waitFor(() => expect(result.current.canConfigure).toBe(true));

    act(() => seam.emitPolicyChange());

    expect(result.current).toMatchObject({ canConfigure: false, loading: true });
    expect(seam.find).toHaveBeenCalledTimes(2);
    await act(() => next.resolve({ policy: 'use_existing_only', can_configure: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({
      policy: 'use_existing_only',
      canConfigure: false,
    });
  });

  it('requires a new authenticated generation before reconnect capability returns', async () => {
    const next = deferred<MCPMemberPolicySetting>();
    const seam = makeClient({ policy: 'allow_private_only', can_configure: true });
    seam.answerNext(next.promise);
    const { result, rerender } = renderHook(
      ({ ready, authGeneration }: { ready: boolean; authGeneration: number }) =>
        useMcpMemberPolicy(seam.client, {
          connectionReady: ready,
          currentUser: MEMBER,
          authGeneration,
        }),
      { initialProps: { ready: true, authGeneration: 1 } }
    );
    await waitFor(() => expect(result.current.canConfigure).toBe(true));
    rerender({ ready: false, authGeneration: 1 });
    expect(result.current.canConfigure).toBe(false);

    rerender({ ready: true, authGeneration: 2 });

    expect(result.current).toMatchObject({ canConfigure: false, loading: true });
    expect(seam.find).toHaveBeenCalledTimes(2);
    await act(() => next.resolve({ policy: 'allow_private_only', can_configure: true }));
    await waitFor(() => expect(result.current.canConfigure).toBe(true));
  });

  it('treats a save response without a capability as withheld', async () => {
    const seam = makeClient({ policy: 'use_existing_only', can_configure: true });
    const { result } = renderHook(() =>
      useMcpMemberPolicy(seam.client, {
        connectionReady: true,
        currentUser: MEMBER,
        authGeneration: 1,
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.save('allow_crud'));

    expect(seam.patch).toHaveBeenCalledWith(null, { policy: 'allow_crud' });
    expect(result.current).toMatchObject({
      policy: 'allow_crud',
      canConfigure: false,
      saving: false,
      error: null,
    });
  });
});
