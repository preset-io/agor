import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplacePromptSuggestion } from './MarketplacePromptSuggestion';

const copyToClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock('../../utils/clipboard', () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}));

describe('MarketplacePromptSuggestion', () => {
  beforeEach(() => {
    copyToClipboard.mockReset();
    copyToClipboard.mockResolvedValue(true);
  });

  it('renders the suggestion and exposes keyboard-focusable ARIA-labelled actions', () => {
    render(
      <MarketplacePromptSuggestion prompt="Try search" onInsert={vi.fn()} onDismiss={vi.fn()} />
    );
    expect(screen.getByText('Try search')).toBeInTheDocument();
    const insert = screen.getByRole('button', { name: 'Insert starter prompt in composer' });
    const copy = screen.getByRole('button', { name: 'Copy starter prompt' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss starter prompt' });
    expect(insert.tagName).toBe('BUTTON');
    expect(copy.tagName).toBe('BUTTON');
    expect(dismiss.tagName).toBe('BUTTON');
    insert.focus();
    expect(insert).toHaveFocus();
  });

  it('inserts only from the user action and keeps copy/dismiss separate', async () => {
    const onInsert = vi.fn();
    const onDismiss = vi.fn();
    render(
      <MarketplacePromptSuggestion prompt="Try search" onInsert={onInsert} onDismiss={onDismiss} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy starter prompt' }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('Try search'));
    expect(onInsert).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Starter prompt copied');
    expect(screen.getByRole('status')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss starter prompt' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onInsert).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Insert starter prompt in composer' }));
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('shows visible copy failure feedback as a live status', async () => {
    copyToClipboard.mockResolvedValue(false);
    render(
      <MarketplacePromptSuggestion prompt="Try search" onInsert={vi.fn()} onDismiss={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy starter prompt' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Could not copy starter prompt')
    );
    expect(screen.getByRole('status')).toBeVisible();
  });

  it('blocks copy when the authority/attempt fence is no longer current', () => {
    const onInsert = vi.fn();
    render(
      <MarketplacePromptSuggestion
        prompt="Try search"
        onInsert={onInsert}
        onDismiss={vi.fn()}
        isCurrent={() => false}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy starter prompt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert starter prompt in composer' }));
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
  });
});
