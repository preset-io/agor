/**
 * Regression: the ChatGPT device sign-in code must copy via the app's shared
 * clipboard utility, not AntD's `copyable`.
 *
 * Agor is commonly reached over HTTP / local-network IPs (a non-secure
 * context). There, AntD's `copyable` awaits `navigator.clipboard`'s rejection
 * before trying its execCommand fallback — and that await consumes the click's
 * transient user activation, so the fallback fails too and nothing is copied.
 * `utils/clipboard` deliberately tries execCommand FIRST in insecure contexts,
 * so the code must route its copy through `useCopyToClipboard`.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';

const { copySpy } = vi.hoisted(() => ({
  copySpy: vi.fn(async () => true),
}));
vi.mock('../../utils/clipboard', () => ({
  copyToClipboard: copySpy,
}));

import { CodexDeviceSignIn } from './CodexDeviceSignIn';

const USER_CODE = 'ABCD-1234';

function makeClient() {
  return {
    service: () => ({
      find: vi.fn(async () => ({ phase: 'idle' })),
      create: vi.fn(async () => ({
        phase: 'pending',
        userCode: USER_CODE,
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      })),
      remove: vi.fn(async () => ({ phase: 'idle' })),
    }),
  } as unknown as import('@agor-live/client').AgorClient;
}

afterEach(() => {
  copySpy.mockClear();
});

describe('CodexDeviceSignIn copy', () => {
  it('copies the sign-in code through the shared clipboard utility', async () => {
    render(
      <CodexDeviceSignIn client={makeClient()} onVerified={vi.fn()} onUseFallback={vi.fn()} />
    );

    expect(await screen.findByText(USER_CODE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in code' }));

    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(USER_CODE));
  });

  it('cancels the exact caller attempt without starting a replacement', async () => {
    const remove = vi.fn(async () => ({ phase: 'idle' }));
    const create = vi.fn(async () => ({
      phase: 'pending',
      attemptId: '01900000-0000-7000-8000-000000000001',
      userCode: USER_CODE,
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }));
    const client = {
      service: () => ({ find: vi.fn(async () => ({ phase: 'idle' })), create, remove }),
    } as unknown as import('@agor-live/client').AgorClient;

    render(<CodexDeviceSignIn client={client} onVerified={vi.fn()} onUseFallback={vi.fn()} />);
    expect(await screen.findByText(USER_CODE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith('01900000-0000-7000-8000-000000000001')
    );
    expect(await screen.findByText('ChatGPT sign-in was cancelled.')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('starts over directly while an approval is still pending', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        phase: 'pending',
        attemptId: '01900000-0000-7000-8000-000000000001',
        userCode: USER_CODE,
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        phase: 'pending',
        attemptId: '01900000-0000-7000-8000-000000000002',
        userCode: 'WXYZ-9876',
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
    const client = {
      service: () => ({
        find: vi.fn(async () => ({ phase: 'idle' })),
        create,
        remove: vi.fn(),
      }),
    } as unknown as import('@agor-live/client').AgorClient;

    render(<CodexDeviceSignIn client={client} onVerified={vi.fn()} onUseFallback={vi.fn()} />);
    expect(await screen.findByText(USER_CODE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));

    expect(await screen.findByText('WXYZ-9876')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not apply a delayed copy result after the auth generation changes', async () => {
    let resolveCopy!: (copied: boolean) => void;
    copySpy.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveCopy = resolve;
      })
    );
    const client = makeClient();
    const view = (authGeneration: number) => (
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <CodexDeviceSignIn
          client={client}
          operationScope={['admin-a', client, authGeneration]}
          onVerified={vi.fn()}
          onUseFallback={vi.fn()}
        />
      </ConnectionProvider>
    );
    const rendered = render(view(7));
    expect(await screen.findByText(USER_CODE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in code' }));
    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(USER_CODE));
    rendered.rerender(view(8));
    await act(async () => resolveCopy(true));

    expect(screen.getByRole('img', { name: 'copy' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'check' })).not.toBeInTheDocument();
  });
});
