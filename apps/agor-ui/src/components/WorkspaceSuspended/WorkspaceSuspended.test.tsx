import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceSuspended } from './WorkspaceSuspended';

describe('WorkspaceSuspended', () => {
  it('states the suspension and where to go next, and names the workspace', () => {
    render(<WorkspaceSuspended workspaceName="Acme Research" />);

    expect(screen.getByText('This workspace is suspended')).toBeInTheDocument();
    expect(screen.getByText('Contact your administrator')).toBeInTheDocument();
    expect(screen.getByText('Acme Research')).toBeInTheDocument();
  });

  it('renders without a workspace label', () => {
    const { container } = render(<WorkspaceSuspended />);

    expect(screen.getByText('This workspace is suspended')).toBeInTheDocument();
    expect(container.textContent).toBe('This workspace is suspendedContact your administrator');
  });

  it('discloses no reason, operator, placement or topology detail', () => {
    const { container } = render(<WorkspaceSuspended workspaceName="Acme Research" />);

    // The screen is the customer-facing half of a neutral denial: everything
    // the restriction record knows stays on the operator side of the boundary.
    expect(container.textContent).not.toMatch(
      /restrict|controller|placement|revision|operation|tenant|cell|replica|database|reason|billing|payment|policy|abuse/i
    );
  });
});
