import type { SessionID } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MobilePromptInput } from './MobilePromptInput';

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: forwardRef<
    HTMLTextAreaElement,
    React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
      onChange?: (value: string) => void;
    }
  >(({ onChange, value, placeholder }, ref) => (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange?.(event.target.value)}
    />
  )),
}));

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
