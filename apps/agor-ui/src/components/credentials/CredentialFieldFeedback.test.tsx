import type { CredentialFixSuggestion } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { CredentialFieldFeedback } from './CredentialFieldFeedback';

function renderFeedback(props: Parameters<typeof CredentialFieldFeedback>[0]) {
  return render(
    <AntApp>
      <CredentialFieldFeedback {...props} />
    </AntApp>
  );
}

const FIX: CredentialFixSuggestion = {
  message: 'This key has extra spaces or line breaks in it — a common side effect.',
  fixedValue: 'sk-ant-api03-abcDEF',
  kinds: ['internal-whitespace'],
};

describe('CredentialFieldFeedback', () => {
  it('renders nothing when there is no fix and no lint', () => {
    const { container } = renderFeedback({});
    expect(container.textContent).toBe('');
  });

  it('shows the opt-in fix warning with a "Clean it up" action that opts in', () => {
    const onApplyFix = vi.fn();
    renderFeedback({ fix: FIX, onApplyFix });

    expect(screen.getByText(FIX.message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clean it up/i }));
    expect(onApplyFix).toHaveBeenCalledTimes(1);
  });

  it('does not render the action button when no handler is provided', () => {
    renderFeedback({ fix: FIX });
    expect(screen.queryByRole('button', { name: /clean it up/i })).not.toBeInTheDocument();
  });

  it('renders a warning lint message', () => {
    renderFeedback({
      lint: { severity: 'warning', code: 'prefix', message: 'Looks off — double-check it.' },
    });
    expect(screen.getByText('Looks off — double-check it.')).toBeInTheDocument();
  });

  it('renders an error lint message', () => {
    renderFeedback({
      lint: { severity: 'error', code: 'charset', message: 'Invalid characters in this key.' },
    });
    expect(screen.getByText('Invalid characters in this key.')).toBeInTheDocument();
  });
});
