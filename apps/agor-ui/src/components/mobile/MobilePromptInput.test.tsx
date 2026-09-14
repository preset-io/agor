import type { SessionID } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobilePromptInput } from './MobilePromptInput';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const sessionId = 'session-1' as SessionID;

describe('MobilePromptInput draft ownership', () => {
  it('does not clear the next caller composer when an old send completes', async () => {
    const send = deferred<boolean>();
    const onSend = vi.fn().mockReturnValue(send.promise);
    const props = (currentUserId: string) => ({
      onSend,
      currentUserId,
      client: null,
      sessionId,
      userById: new Map(),
    });
    const view = render(<MobilePromptInput {...props('user-a')} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'same prompt' } });
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('same prompt'));

    view.rerender(<MobilePromptInput {...props('user-b')} />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'same prompt' } });

    await act(async () => send.resolve(true));
    expect(screen.getByRole('textbox')).toHaveValue('same prompt');
  });
});

describe('MobilePromptInput', () => {
  // Regression: focusing the composer on a real phone zoomed the visual
  // viewport in and never zoomed back out on blur, leaving message rows
  // running off the right edge until the user pinched out. WebKit on iOS does
  // that to any focused form control rendering below 16px, and antd's default
  // token.fontSize is 14px.
  it('renders the textarea at the iOS no-autozoom threshold', () => {
    render(
      <MobilePromptInput onSend={vi.fn()} client={null} sessionId={null} userById={new Map()} />
    );

    const textarea = screen.getByRole('textbox');
    expect(Number.parseFloat(textarea.style.fontSize)).toBeGreaterThanOrEqual(16);
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeInTheDocument();
  });

  // The @-mention highlights are painted on a separate layer behind the
  // textarea, so bumping only the textarea's font size would slide them out of
  // register with the text they underline.
  it('keeps the mention highlight overlay on the same text metrics', () => {
    const { container } = render(
      <MobilePromptInput onSend={vi.fn()} client={null} sessionId={null} userById={new Map()} />
    );

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'ping @amin' } });
    const overlay = container.querySelector<HTMLElement>('div[aria-hidden="true"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.style.fontSize).toBe(textarea.style.fontSize);
  });
});
