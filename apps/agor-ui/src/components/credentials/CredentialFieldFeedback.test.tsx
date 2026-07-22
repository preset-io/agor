import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_INTERNAL_FIX_NOTICE, CredentialFieldFeedback } from './CredentialFieldFeedback';

function renderFeedback(props: Parameters<typeof CredentialFieldFeedback>[0]) {
  return render(
    <AntApp>
      <CredentialFieldFeedback {...props} />
    </AntApp>
  );
}

describe('CredentialFieldFeedback', () => {
  it('renders nothing when there is no notice and no lint', () => {
    const { container } = renderFeedback({});
    expect(container.textContent).toBe('');
  });

  it('shows the dismissible internal-fix notice and dismisses it', () => {
    const onDismiss = vi.fn();
    renderFeedback({ internalFixVisible: true, onDismissInternalFix: onDismiss });

    expect(screen.getByText(CREDENTIAL_INTERNAL_FIX_NOTICE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
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
