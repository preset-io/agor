import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactRuntimeReporting, useArtifactRuntimeOwner } from './ArtifactRenderSupport';

const mock = vi.hoisted(() => ({
  logs: [] as { method: string; data: unknown[] }[],
  postMessage: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock('@codesandbox/sandpack-react', () => ({
  useSandpack: () => ({
    sandpack: {
      status: 'running',
      error: null,
      clients: { preview: { iframe: { contentWindow: { postMessage: mock.postMessage } } } },
    },
    listen: () => () => {},
  }),
  useSandpackConsole: () => ({ logs: mock.logs }),
}));
vi.mock('@/config/daemon', () => ({ getDaemonUrl: () => 'https://daemon.test' }));
vi.mock('@/utils/authHeaders', () => ({
  getAuthHeaders: () => ({ Authorization: 'test-only' }),
  getCurrentUserIdFromJwt: () => 'user-1',
}));

const consoleReports = () =>
  mock.fetch.mock.calls.filter(([url]) => String(url).endsWith('/console')).length;

beforeEach(() => {
  mock.logs = [];
  mock.postMessage.mockReset();
  mock.fetch.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useArtifactRuntimeOwner', () => {
  it('lets a mounted preview own the artifact, and hands it back when the preview goes', () => {
    const canvas = renderHook(() => useArtifactRuntimeOwner('artifact-a', false));
    expect(canvas.result.current).toBe(true);

    const preview = renderHook(() => useArtifactRuntimeOwner('artifact-a', true));
    expect(preview.result.current).toBe(true);
    expect(canvas.result.current).toBe(false);
    // Other artifacts are unaffected.
    expect(renderHook(() => useArtifactRuntimeOwner('artifact-b', false)).result.current).toBe(
      true
    );

    preview.unmount();
    expect(canvas.result.current).toBe(true);
  });
});

describe('ArtifactRuntimeReporting', () => {
  const copies = () => (
    <>
      {/* The board card, hidden in Chat, and the preview of the same artifact. */}
      <ArtifactRuntimeReporting artifactId="artifact-a" contentHash="hash-a" />
      <ArtifactRuntimeReporting artifactId="artifact-a" contentHash="hash-a" claim />
    </>
  );

  it('sends each console entry once and answers each DOM query once', async () => {
    const { rerender } = render(copies());
    mock.logs = [{ method: 'log', data: ['hello'] }];
    await act(async () => rerender(copies()));
    expect(consoleReports()).toBe(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('agor:artifact-runtime-query', {
          detail: {
            request_id: 'request-1',
            artifact_id: 'artifact-a',
            requested_by_user_id: 'user-1',
            kind: 'query',
            args: {},
          },
        })
      );
    });
    expect(mock.postMessage).toHaveBeenCalledTimes(1);
  });
});
