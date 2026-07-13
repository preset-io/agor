import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkOverflowAction } from './LinkActions';

describe('LinkOverflowAction', () => {
  it('disables the trigger when its only action is unavailable', () => {
    const onAction = vi.fn();
    render(
      <LinkOverflowAction
        ariaLabel="Teammate actions for Runbook"
        actionLabel="Remove from teammate"
        disabled
        onAction={onAction}
      />
    );

    const trigger = screen.getByLabelText('Teammate actions for Runbook');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByText('Remove from teammate')).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });
});
