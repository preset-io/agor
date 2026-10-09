import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  copy: vi.fn<(text: string) => Promise<boolean>>(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));
vi.mock('@/utils/clipboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/clipboard')>()),
  copyToClipboard: mocks.copy,
}));
vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: mocks.showSuccess, showError: mocks.showError }),
}));

import { ArtifactLegacyNotice, ArtifactLoadErrorNotice } from './ArtifactNotices';

beforeEach(() => vi.clearAllMocks());

describe('ArtifactLegacyNotice', () => {
  it.each([
    {
      copied: true,
      toast: 'showSuccess',
      text: 'Upgrade prompt copied. Paste it into a session to update the artifact.',
    },
    {
      copied: false,
      toast: 'showError',
      text: "Couldn't copy. Select the text and copy it manually.",
    },
  ] as const)('copy $copied: $text', async ({ copied, toast, text }) => {
    mocks.copy.mockResolvedValue(copied);
    render(<ArtifactLegacyNotice upgradeInstructions="Rewrite as a React app." />);
    expect(
      screen.getByText('This artifact uses an older format and may not display correctly.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy upgrade prompt' }));
    await waitFor(() => expect(mocks[toast]).toHaveBeenCalledWith(text));
    expect(mocks.copy).toHaveBeenCalledWith('Rewrite as a React app.');
  });
});

describe('ArtifactLoadErrorNotice', () => {
  it.each([
    { status: 500, message: "Couldn't load this artifact.", action: true },
    { status: 403, message: "You don't have access to this artifact.", action: false },
    { status: 404, message: 'This artifact no longer exists.', action: false },
  ])('$status: $message', ({ status, message, action }) => {
    const onRetry = vi.fn();
    render(<ArtifactLoadErrorNotice failure={{ status, message: 'raw' }} onRetry={onRetry} />);
    expect(screen.getByText(message)).toBeInTheDocument();
    const tryAgain = screen.queryByRole('button', { name: 'Try again' });
    expect(tryAgain !== null).toBe(action);
    if (tryAgain) {
      fireEvent.click(tryAgain);
      expect(onRetry).toHaveBeenCalledOnce();
    }
  });
});
