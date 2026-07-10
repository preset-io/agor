import { fireEvent, render, screen } from '@testing-library/react';
import { Button } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ActionLinkRow } from './ActionLinkRow';

describe('ActionLinkRow', () => {
  it('keeps primary activation and secondary actions independent', () => {
    const onActivate = vi.fn();
    const onSecondary = vi.fn();

    render(
      <ActionLinkRow
        ariaLabel="Open example"
        onActivate={onActivate}
        actions={
          <Button aria-label="Secondary action" onClick={onSecondary}>
            Secondary
          </Button>
        }
      >
        Example link
      </ActionLinkRow>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Secondary action' }));
    expect(onSecondary).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open example' }));
    expect(onActivate).toHaveBeenCalledOnce();
  });
});
