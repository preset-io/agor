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

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const copySpy = vi.fn(async () => true);
vi.mock('../../utils/clipboard', () => ({
  useCopyToClipboard: () => [false, copySpy] as const,
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
});
