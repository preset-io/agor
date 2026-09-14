import type { ArtifactSandpackReport } from '@agor/core/types';
import type { SandpackClientListen, SandpackState } from '@codesandbox/sandpack-react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactSandpackErrorReporter } from './ArtifactSandpackErrorReporter';

type Listener = Parameters<SandpackClientListen>[0];
const mock = vi.hoisted(() => ({
  sandpack: { status: 'running', error: null } as Pick<SandpackState, 'status' | 'error'>,
  listen: vi.fn<SandpackClientListen>(),
  listeners: new Set<Listener>(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock('@codesandbox/sandpack-react', () => ({
  useSandpack: () => ({ sandpack: mock.sandpack, listen: mock.listen }),
}));
vi.mock('@/config/daemon', () => ({ getDaemonUrl: () => 'https://daemon.test' }));
vi.mock('@/utils/authHeaders', () => ({ getAuthHeaders: () => ({ Authorization: 'test-only' }) }));

function messages(): ArtifactSandpackReport[] {
  return mock.fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
}
function emit(message: Parameters<Listener>[0]) {
  act(() => {
    for (const listener of mock.listeners) listener(message);
  });
}
async function flush() {
  await act(() => vi.advanceTimersByTimeAsync(1000));
}

beforeEach(() => {
  vi.useFakeTimers();
  mock.sandpack.status = 'running';
  mock.sandpack.error = null;
  mock.listeners.clear();
  mock.listen.mockImplementation((listener) => {
    mock.listeners.add(listener);
    return () => {
      mock.listeners.delete(listener);
    };
  });
  mock.fetch.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ArtifactSandpackErrorReporter', () => {
  it('requires done, not provider running or connection, to report success', async () => {
    render(<ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />);
    await flush();
    expect(messages().at(-1)).toMatchObject({ status: 'running', compilation_status: 'pending' });
    emit({ type: 'connected' });
    await flush();
    expect(messages().at(-1)?.compilation_status).toBe('pending');
    emit({ type: 'start', firstLoad: true });
    await flush();
    expect(messages().at(-1)?.compilation_status).toBe('compiling');
    emit({ type: 'done', compilatonError: false });
    await flush();
    expect(messages().at(-1)).toMatchObject({
      status: 'running',
      compilation_status: 'success',
      content_hash: 'revision-a',
      error: null,
    });
  });

  it('accepts static-client completion without a start event and resets on recompilation', async () => {
    render(<ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />);
    emit({ type: 'done', compilatonError: false });
    await flush();
    expect(messages().at(-1)?.compilation_status).toBe('success');
    emit({ type: 'start', firstLoad: false });
    await flush();
    expect(messages().at(-1)?.compilation_status).toBe('compiling');
    emit({ type: 'done', compilatonError: true });
    await flush();
    expect(messages().at(-1)?.compilation_status).toBe('error');
  });

  it('never attributes old completion to new content and unsubscribes on unmount', async () => {
    const { rerender, unmount } = render(
      <ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />
    );
    emit({ type: 'done', compilatonError: false });
    await flush();
    rerender(<ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-b" />);
    await flush();
    const newReports = messages().filter((report) => report.content_hash === 'revision-b');
    expect(newReports.length).toBeGreaterThan(0);
    expect(newReports.every((report) => report.compilation_status === 'pending')).toBe(true);
    expect(mock.listeners.size).toBe(1);
    unmount();
    expect(mock.listeners.size).toBe(0);
  });

  it('preserves completion when Sandpack replaces its listener registration function', async () => {
    const { rerender } = render(
      <ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />
    );
    emit({ type: 'done', compilatonError: false });
    await flush();
    mock.listen = vi.fn(mock.listen.getMockImplementation());
    rerender(<ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />);
    await flush();
    expect(messages().at(-1)?.compilation_status).toBe('success');
    expect(mock.listeners.size).toBe(1);
    emit({ type: 'start', firstLoad: false });
    await flush();
    expect(messages().at(-1)?.compilation_status).toBe('compiling');
  });

  it('requires fresh completion when the provider restarts with the same content', async () => {
    const { rerender } = render(
      <ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />
    );
    emit({ type: 'done', compilatonError: false });
    await flush();
    mock.sandpack.status = 'idle';
    rerender(<ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />);
    await flush();
    mock.sandpack.status = 'running';
    rerender(<ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />);
    await flush();
    expect(messages().at(-1)?.compilation_status).toBe('pending');
    emit({ type: 'done', compilatonError: false });
    await flush();
    expect(messages().at(-1)?.compilation_status).toBe('success');
  });

  it('reports runtime error details after completion instead of preserving success', async () => {
    const { rerender } = render(
      <ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />
    );
    emit({ type: 'done', compilatonError: false });
    await flush();
    mock.sandpack.error = {
      message: 'boot failed',
      title: 'Error',
      path: '/App.js',
      line: 1,
      column: 0,
    };
    rerender(<ArtifactSandpackErrorReporter artifactId="artifact-a" contentHash="revision-a" />);
    await flush();
    expect(messages().at(-1)).toMatchObject({
      compilation_status: 'error',
      error: mock.sandpack.error,
    });
  });
});
