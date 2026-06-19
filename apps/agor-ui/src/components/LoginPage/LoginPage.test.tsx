import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

vi.mock('./ParticleBackground', () => ({
  ParticleBackground: () => null,
}));

describe('LoginPage external launch redirect', () => {
  const currentPath = () =>
    `${window.location.pathname}${window.location.search}${window.location.hash}`;

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });
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
    expect(returnLink).toHaveAttribute(
      'href',
      `https://workspace.example.com/open?return_to=${encodeURIComponent(currentPath())}`
    );
    expect(screen.queryByPlaceholderText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign In' })).not.toBeInTheDocument();
  });

  it('does not show first-time admin setup guidance on the local login form', () => {
    render(<LoginPage onLogin={vi.fn()} />);

    expect(screen.queryByText(/First-time server setup/)).not.toBeInTheDocument();
    expect(screen.queryByText('agor user create-admin')).not.toBeInTheDocument();
  });

  it('passes the current deep link to the external launcher as return_to', () => {
    window.history.replaceState({}, '', '/ui/s/session123/?panel=right#msg-1');

    render(
      <LoginPage
        onLogin={vi.fn()}
        externalLaunchLoginRedirectUrl="https://workspace.example.com/open?source=agor"
      />
    );

    const returnLink = screen.getByRole('link', { name: 'Return to workspace' });
    const href = returnLink.getAttribute('href');
    expect(href).toBe(
      `https://workspace.example.com/open?source=agor&return_to=${encodeURIComponent(currentPath())}`
    );
  });

  it('replaces an existing return_to on the external launcher URL', () => {
    window.history.replaceState({}, '', '/ui/w/branch123/');

    render(
      <LoginPage
        onLogin={vi.fn()}
        externalLaunchLoginRedirectUrl="https://workspace.example.com/open?return_to=https%3A%2F%2Fevil.example%2F"
      />
    );

    const returnLink = screen.getByRole('link', { name: 'Return to workspace' });
    const href = new URL(returnLink.getAttribute('href') ?? '');
    expect(href.searchParams.getAll('return_to')).toEqual([currentPath()]);
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
      `https://workspace.example.com/open?return_to=${encodeURIComponent(currentPath())}`
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
    expect(screen.queryByText(/First-time server setup/)).not.toBeInTheDocument();
    expect(screen.queryByText('agor user create-admin')).not.toBeInTheDocument();
  });
});
