/**
 * Regression tests for ForkSpawnModal prompt preservation.
 *
 * Bug: when a fork failed (sync error from onConfirm), the modal used to
 * unconditionally reset fields and close — the user's typed prompt was
 * wiped from the compose box with no way to recover it.
 *
 * These tests pin the guardrail: on onConfirm rejection the modal stays
 * open and the typed prompt is preserved.
 */

import type { Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ForkSpawnModal } from './ForkSpawnModal';

// The AutocompleteTextarea depends on a live client + DOM APIs that are
// expensive to mock. Replace it with a plain textarea that forwards value
// through the provided onChange so we can drive the form deterministically.
vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      data-testid="prompt-textarea"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const mockSession: Partial<Session> = {
  session_id: 'session-parent',
  title: 'Parent Session',
  agentic_tool: 'claude-code',
};

// 10s timeout per test: these exercise full Antd Modal mount + async
// confirm + waitFor cycles which intermittently brush against vitest's
// 5s default on slower CI runners (observed flaking on multiple PRs).
describe('ForkSpawnModal prompt preservation', { timeout: 10_000 }, () => {
  it('keeps the modal open and preserves the typed prompt when fork fails', async () => {
    const typedPrompt = 'please investigate the failing migration';
    const onConfirm = vi.fn().mockRejectedValue(new Error('Executor spawn failed'));
    const onCancel = vi.fn();

    render(
      <ForkSpawnModal
        open
        action="fork"
        session={mockSession as Session}
        onConfirm={onConfirm}
        onCancel={onCancel}
        client={null}
        userById={new Map()}
      />
    );

    // Type the prompt
    const textarea = screen.getByTestId('prompt-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: typedPrompt } });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /Fork Session/i }));

    // Fork should have been attempted with the typed prompt
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(typedPrompt));

    // After the rejection, the modal must NOT have been dismissed and the
    // prompt must still be in the textarea so the user can retry.
    expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByTestId('prompt-textarea') as HTMLTextAreaElement).value).toBe(typedPrompt);
  });

  it('clears the form and closes only after a successful confirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();

    render(
      <ForkSpawnModal
        open
        action="fork"
        session={mockSession as Session}
        onConfirm={onConfirm}
        onCancel={onCancel}
        client={null}
        userById={new Map()}
      />
    );

    const textarea = screen.getByTestId('prompt-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'do the thing' } });

    fireEvent.click(screen.getByRole('button', { name: /Fork Session/i }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('do the thing'));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});
