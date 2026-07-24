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
});
