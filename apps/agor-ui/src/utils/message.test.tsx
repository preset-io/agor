import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  const { showError, showInfo, showLoading, showSuccess, showWarning } = useThemedMessage();

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
      <button
        type="button"
        onClick={() => showSuccess('Success severity', { key: 'severity-success' })}
      >
        Show success severity
      </button>
      <button type="button" onClick={() => showInfo('Info severity', { key: 'severity-info' })}>
        Show info severity
      </button>
      <button
        type="button"
        onClick={() => showWarning('Warning severity', { key: 'severity-warning' })}
      >
        Show warning severity
      </button>
      <button
        type="button"
        onClick={() => showLoading('Loading severity', { key: 'severity-loading' })}
      >
        Show loading severity
      </button>
      <button type="button" onClick={() => showError('Error severity', { key: 'severity-error' })}>
        Show error severity
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

    const trigger = screen.getByRole('button', { name: 'Show persistent error' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByText('Persistent failure')).toBeInTheDocument();

    await act(() => sleep(6_100));
    expect(screen.getByText('Persistent failure')).toBeInTheDocument();

    const dismissButton = screen.getByRole('button', { name: 'Dismiss error message' });
    expect(dismissButton.tagName).toBe('BUTTON');
    expect(dismissButton).toHaveAccessibleName('Dismiss error message');
    expect(dismissButton).toHaveAttribute('title', 'Dismiss error message');
    expect(dismissButton).toHaveTextContent(/^$/);

    dismissButton.focus();
    fireEvent.click(dismissButton);
    await waitFor(() => expect(screen.queryByText('Persistent failure')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

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

  it('renders an icon-only semantic copy button for every message severity', async () => {
    renderHarness();

    const severities = [
      ['Show success severity', 'Success severity', 'Copy message'],
      ['Show info severity', 'Info severity', 'Copy message'],
      ['Show warning severity', 'Warning severity', 'Copy message'],
      ['Show loading severity', 'Loading severity', 'Copy message'],
      ['Show error severity', 'Error severity', 'Copy error message'],
    ] as const;

    for (const [triggerName, content, copyName] of severities) {
      fireEvent.click(screen.getByRole('button', { name: triggerName }));
      const messageText = await screen.findByText(content);
      expect(messageText).toBeInTheDocument();

      const copyButton = within(messageText.closest('[role="alert"]') as HTMLElement).getByRole(
        'button',
        { name: copyName }
      );
      expect(copyButton.tagName).toBe('BUTTON');
      expect(copyButton).toHaveTextContent(/^$/);
    }
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
