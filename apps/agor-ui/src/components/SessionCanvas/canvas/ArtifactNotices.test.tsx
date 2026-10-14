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

import { ErrorBoundary } from '../../ErrorBoundary';
import {
  ArtifactCrashNotice,
  ArtifactLegacyNotice,
  ArtifactLoadErrorNotice,
} from './ArtifactNotices';

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
    { raw: 'socket hang up', message: "Couldn't load this artifact.", action: true },
    {
      raw: 'Artifact 0199a1b2-c3d4 not found',
      message:
        "This artifact isn't available. It may have been deleted, or you may not have access.",
      action: false,
    },
  ])('$raw: $message', ({ raw, message, action }) => {
    const onRetry = vi.fn();
    render(<ArtifactLoadErrorNotice failure={{ status: 500, message: raw }} onRetry={onRetry} />);
    expect(screen.getByText(message)).toBeInTheDocument();
    const tryAgain = screen.queryByRole('button', { name: 'Try again' });
    expect(tryAgain !== null).toBe(action);
    if (tryAgain) {
      fireEvent.click(tryAgain);
      expect(onRetry).toHaveBeenCalledOnce();
    }
  });
});

describe('ArtifactCrashNotice', () => {
  function Throw(): never {
    throw new TypeError(
      'Failed to fetch dynamically imported module: http://localhost/ui/assets/ArtifactNode-C5Z75nfP.js'
    );
  }

  it('keeps a failed artifact chunk inside the node with a reload action', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary variant="scoped" fallback={(error) => <ArtifactCrashNotice error={error} />}>
        <Throw />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this artifact.");
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    expect(screen.queryByText("Well, that wasn't supposed to happen.")).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
