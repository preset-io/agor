import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamdownPortalApp } from '../components/StreamdownPortalApp';

const { copyToClipboard } = vi.hoisted(() => ({
  copyToClipboard: vi.fn<(text: string) => Promise<boolean>>(),
}));
vi.mock('./clipboard', () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}));

import { useThemedMessage } from './message';

const sleep = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));

function MessageHarness({ onClose = () => {} }: { onClose?: () => void }) {
  const { showError, showLoading, showSuccess } = useThemedMessage();

  return (
    <>
      <button type="button" onClick={() => showError('Persistent failure', { onClose })}>
        Show persistent error
      </button>
      <button type="button" onClick={() => showError('Transient failure', { duration: 0.05 })}>
        Show transient error
      </button>
      <button
        type="button"
        onClick={() =>
          showError(
            <>
              Public message <strong>safe detail</strong>
            </>
          )
        }
      >
        Show copyable error
      </button>
      <button type="button" onClick={() => showError('First failure')}>
        Show first error
      </button>
      <button type="button" onClick={() => showError('Second failure')}>
        Show second error
      </button>
      <button type="button" onClick={() => showLoading('Working', { key: 'operation' })}>
        Show keyed loading
      </button>
      <button type="button" onClick={() => showError('Operation failed', { key: 'operation' })}>
        Show keyed error
      </button>
      <button type="button" onClick={() => showSuccess('Operation complete', { key: 'operation' })}>
        Show keyed success
      </button>
    </>
  );
}

function renderHarness(onClose?: () => void) {
  return render(
    <StreamdownPortalApp>
      <MessageHarness onClose={onClose} />
    </StreamdownPortalApp>
  );
}

describe('useThemedMessage', () => {
  beforeEach(() => {
    copyToClipboard.mockReset();
    copyToClipboard.mockResolvedValue(true);
  });

  it('keeps errors past the former timeout and preserves an explicit duration escape hatch', async () => {
    renderHarness();

    fireEvent.click(screen.getByRole('button', { name: 'Show persistent error' }));
    expect(await screen.findByText('Persistent failure')).toBeInTheDocument();

    await act(() => sleep(6_100));
    expect(screen.getByText('Persistent failure')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error message' }));
    await waitFor(() => expect(screen.queryByText('Persistent failure')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Show transient error' }));
    expect(await screen.findByText('Transient failure')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Transient failure')).not.toBeInTheDocument());
  });

  it('copies only normalized visible text and exposes announced feedback without moving focus', async () => {
    renderHarness();
    const trigger = screen.getByRole('button', { name: 'Show copyable error' });
    trigger.focus();
    fireEvent.click(trigger);

    expect(await screen.findByText('Public message')).toBeInTheDocument();
    expect(trigger).toHaveFocus();

    const copyButton = screen.getByRole('button', { name: 'Copy error message' });
    copyButton.focus();
    fireEvent.click(copyButton);

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('Public message safe detail'));
    expect(copyButton).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Error message copied to clipboard.');
    expect(copyButton).toHaveAccessibleName('Copied error message');
  });

  it('announces clipboard failures while keeping the copy control available', async () => {
    copyToClipboard.mockResolvedValueOnce(false);
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'Show copyable error' }));

    const copyButton = await screen.findByRole('button', { name: 'Copy error message' });
    copyButton.focus();
    fireEvent.click(copyButton);

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Could not copy error message.')
    );
    expect(copyButton).toHaveAccessibleName('Copy failed for error message');
    expect(copyButton).toHaveFocus();
  });

  it('keeps multiple errors independently reviewable and moves focus to the next error on dismiss', async () => {
    const onClose = vi.fn();
    renderHarness(onClose);

    fireEvent.click(screen.getByRole('button', { name: 'Show persistent error' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show second error' }));

    expect(await screen.findByText('Persistent failure')).toBeInTheDocument();
    expect(screen.getByText('Second failure')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(2);

    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss error message' });
    dismissButtons[0].focus();
    fireEvent.click(dismissButtons[0]);

    await waitFor(() => expect(screen.queryByText('Persistent failure')).not.toBeInTheDocument());
    expect(screen.getByText('Second failure')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss error message' })).toHaveFocus();
    expect(onClose).toHaveBeenCalledTimes(1);

    const list = document.querySelector<HTMLElement>('.ant-message-list');
    expect(list).toHaveStyle({
      maxHeight: 'calc(100vh - 16px)',
      overflowY: 'auto',
      scrollbarWidth: 'thin',
    });
  });

  it('replaces keyed loading and errors in place, then resolves them with success', async () => {
    renderHarness();

    fireEvent.click(screen.getByRole('button', { name: 'Show keyed loading' }));
    expect(await screen.findByText('Working')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show keyed error' }));
    await waitFor(() => expect(screen.queryByText('Working')).not.toBeInTheDocument());
    expect(screen.getByText('Operation failed')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Dismiss error message' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show keyed success' }));
    await waitFor(() => expect(screen.queryByText('Operation failed')).not.toBeInTheDocument());
    expect(screen.getByText('Operation complete')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Dismiss error message' })).not.toBeInTheDocument();
  });
});
