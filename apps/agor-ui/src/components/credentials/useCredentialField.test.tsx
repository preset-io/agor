import { act, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialFieldFeedback } from './CredentialFieldFeedback';
import { useCredentialFields } from './useCredentialField';

const FIELD = 'ANTHROPIC_API_KEY';

// Mirrors the paste pattern every surface uses: the input value updates AFTER
// the paste event, so the handler defers and reads the DOM value on the next tick.
function Harness() {
  const cred = useCredentialFields();
  const [value, setValue] = useState('');
  const state = cred.get(FIELD);
  return (
    <AntApp>
      <input
        aria-label="key"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          cred.reset(FIELD);
        }}
        onPaste={(e) => {
          const el = e.currentTarget;
          window.setTimeout(() => {
            const normalized = cred.normalizeOnInput(FIELD, el.value);
            setValue(normalized);
            cred.lintOnBlur(FIELD, normalized);
          }, 0);
        }}
      />
      <CredentialFieldFeedback lint={state.lint} internalFixVisible={state.showInternalFix} />
    </AntApp>
  );
}

describe('useCredentialFields — paste timing (deferred DOM read)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('normalizes the pasted value on the next tick and surfaces the internal-fix notice', () => {
    render(<Harness />);
    const input = screen.getByLabelText<HTMLInputElement>('key');

    // Simulate the browser applying the paste (DOM value set) before our
    // deferred handler reads it. The value carries a mid-token space.
    input.value = 'sk-ant-api03-abc DEF0123456789';
    fireEvent.paste(input);

    // Before the timer fires, nothing is normalized yet.
    expect(screen.queryByText(/we removed/i)).not.toBeInTheDocument();

    act(() => {
      vi.runAllTimers();
    });

    expect(input.value).toBe('sk-ant-api03-abcDEF0123456789');
    expect(
      screen.getByText(/we removed spaces, line breaks, or wrapping quotes/i)
    ).toBeInTheDocument();
  });
});
