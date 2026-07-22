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
          window.setTimeout(() => setValue(cred.inspect(FIELD, el.value)), 0);
        }}
      />
      <CredentialFieldFeedback
        lint={state.lint}
        fix={state.fix}
        onApplyFix={() => setValue(cred.applyFix(FIELD, value))}
      />
    </AntApp>
  );
}

describe('useCredentialFields — paste timing + opt-in fix', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sanitizes edges on paste but keeps the internal space, then fixes only on click', () => {
    render(<Harness />);
    const input = screen.getByLabelText<HTMLInputElement>('key');

    // Browser applies the paste (DOM value set) before our deferred handler reads
    // it. The value has edge whitespace AND a mid-token space.
    input.value = '  sk-ant-api03-abc DEF0123456789  ';
    fireEvent.paste(input);

    act(() => {
      vi.runAllTimers();
    });

    // Always-safe cleanup trimmed the edges; the internal space is PRESERVED.
    expect(input.value).toBe('sk-ant-api03-abc DEF0123456789');
    // A warning offers the opt-in fix — nothing was rewritten automatically.
    expect(screen.getByText(/extra spaces or line breaks/i)).toBeInTheDocument();

    // The user opts in.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /clean it up/i }));
    });
    expect(input.value).toBe('sk-ant-api03-abcDEF0123456789');
    expect(screen.queryByText(/extra spaces or line breaks/i)).not.toBeInTheDocument();
  });
});
