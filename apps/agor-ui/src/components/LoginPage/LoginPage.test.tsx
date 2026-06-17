import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

vi.mock('./ParticleBackground', () => ({
  ParticleBackground: () => null,
}));

describe('LoginPage external launch redirect', () => {
  it('keeps the local login form as the default when no redirect is configured', () => {
    render(<LoginPage onLogin={vi.fn()} />);

    expect(screen.getByPlaceholderText('Email address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Return to workspace' })).not.toBeInTheDocument();
  });

  it('shows the external launch return action as the primary path when configured', () => {
    render(
      <LoginPage
        onLogin={vi.fn()}
        externalLaunchLoginRedirectUrl="https://workspace.example.com/open"
      />
    );

    const returnLink = screen.getByRole('link', { name: 'Return to workspace' });
    expect(returnLink).toHaveAttribute('href', 'https://workspace.example.com/open');
    expect(screen.queryByPlaceholderText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign In' })).not.toBeInTheDocument();
  });

  it('shows concise first-time admin setup guidance on the local login form', () => {
    render(<LoginPage onLogin={vi.fn()} />);

    expect(screen.getByText(/First-time server setup/)).toBeInTheDocument();
    expect(screen.getByText('agor user create-admin')).toBeInTheDocument();
    expect(screen.queryByText(/New user/)).not.toBeInTheDocument();
    expect(screen.queryByText(/💡/)).not.toBeInTheDocument();
  });

  it('offers local login as a secondary fallback for configured deployments', () => {
    render(
      <LoginPage
        onLogin={vi.fn()}
        externalLaunchLoginRedirectUrl="https://workspace.example.com/open"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use local login instead' }));

    expect(screen.getByPlaceholderText('Email address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
  });

  it('pairs launch errors with the external return action', () => {
    render(
      <LoginPage
        onLogin={vi.fn()}
        error="Launch sign-in failed. The one-time launch code may have expired or already been used."
        externalLaunchLoginRedirectUrl="https://workspace.example.com/open"
      />
    );

    expect(screen.getByText('Launch sign-in failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return to workspace' })).toHaveAttribute(
      'href',
      'https://workspace.example.com/open'
    );
  });

  it('does not label local-login errors as launch failures when external launch is configured', () => {
    render(
      <LoginPage
        onLogin={vi.fn()}
        error="Invalid email or password"
        externalLaunchLoginRedirectUrl="https://workspace.example.com/open"
      />
    );

    expect(screen.getByText('Login Failed')).toBeInTheDocument();
    expect(screen.queryByText('Launch sign-in failed')).not.toBeInTheDocument();
    expect(screen.getByText(/First-time server setup/)).toBeInTheDocument();
    expect(screen.getByText('agor user create-admin')).toBeInTheDocument();
  });
});
