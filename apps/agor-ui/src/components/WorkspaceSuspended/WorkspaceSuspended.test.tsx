import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceSuspended } from './WorkspaceSuspended';

describe('WorkspaceSuspended', () => {
  it('states the suspension and where to go next', () => {
    render(<WorkspaceSuspended />);

    expect(screen.getByText('This workspace is suspended')).toBeInTheDocument();
    expect(screen.getByText('Contact your administrator')).toBeInTheDocument();
  });

  it('discloses nothing else — no reason, operator, deployment or topology detail', () => {
    const { container } = render(<WorkspaceSuspended />);

    // The screen is the customer-facing half of a neutral denial. It carries
    // exactly the two lines above: no instance/Cell label, and nothing the
    // restriction record knows.
    expect(container.textContent).toBe('This workspace is suspendedContact your administrator');
    expect(container.textContent).not.toMatch(
      /restrict|controller|placement|revision|operation|tenant|cell|replica|database|reason|billing|payment|policy|abuse/i
    );
  });
});
