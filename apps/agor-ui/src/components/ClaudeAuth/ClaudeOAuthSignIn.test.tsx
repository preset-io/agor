import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ClaudeOAuthSignIn } from './ClaudeOAuthSignIn';

describe('ClaudeOAuthSignIn', () => {
  it('requires a committed attempt AND caller-private usable backend status before confirmation', async () => {
    let resolveStatus!: (result: unknown) => void;
    const status = new Promise((resolve) => {
      resolveStatus = resolve;
    });
    const onVerified = vi.fn();
    const client = {
      service: (name: string) =>
        name === 'claude-auth/oauth'
          ? {
              find: async () => ({ phase: 'success', attemptId: 'backend-attempt' }),
              create: vi.fn(),
            }
          : { create: () => status },
    } as never;
    render(<ClaudeOAuthSignIn client={client} storage="backend" onVerified={onVerified} />);
    await screen.findByText(/Confirming the current personal grant/);
    expect(onVerified).not.toHaveBeenCalled();
    resolveStatus({
      status: 'unknown',
      authenticated: false,
      managedOAuth: { saved: true, usable: true },
    });
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
  });

  it('does not confirm a missing backend grant from a historical success or source marker', async () => {
    const onVerified = vi.fn();
    const check = vi.fn(async () => ({
      status: 'unauthenticated',
      managedOAuth: { saved: false, usable: false },
    }));
    const client = {
      service: (name: string) =>
        name === 'claude-auth/oauth'
          ? { find: async () => ({ phase: 'success', attemptId: 'old-attempt' }), create: vi.fn() }
          : { create: check },
    } as never;
    render(
      <ClaudeOAuthSignIn client={client} storage="backend" connected onVerified={onVerified} />
    );
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(onVerified).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Start over' })).toBeInTheDocument();
    check.mockResolvedValueOnce({ status: 'unknown', managedOAuth: { saved: true, usable: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry confirmation' }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
  });

  it('echoes the adopted attempt id when submitting the pasted code', async () => {
    const create = vi.fn(async () => ({ phase: 'success', attemptId: 'attempt-1' }));
    const find = vi.fn(async () => ({
      phase: 'awaiting_code',
      attemptId: 'attempt-1',
      verificationUrl: 'https://claude.example/authorize',
    }));
    const client = {
      service: vi.fn(() => ({ create, find })),
    } as never;

    render(<ClaudeOAuthSignIn client={client} onVerified={vi.fn()} autoStart={false} />);

    const input = await screen.findByLabelText('Claude authorization code');
    fireEvent.change(input, { target: { value: 'CODE#STATE' } });
    fireEvent.click(screen.getByText('Complete sign-in').closest('button') as HTMLButtonElement);

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        code: 'CODE#STATE',
        attemptId: 'attempt-1',
      })
    );
  });

  it('offers a fresh start when a durable status cannot reconstruct the raw-state URL', async () => {
    const create = vi.fn(async () => ({
      phase: 'awaiting_code',
      attemptId: 'attempt-2',
      verificationUrl: 'https://claude.example/fresh',
    }));
    const find = vi.fn(async () => ({ phase: 'awaiting_code', attemptId: 'attempt-1' }));
    const client = {
      service: vi.fn(() => ({ create, find })),
    } as never;

    render(<ClaudeOAuthSignIn client={client} onVerified={vi.fn()} autoStart={false} />);

    expect(
      await screen.findByText(/browser no longer has the original sign-in link/i)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('Start over').closest('button') as HTMLButtonElement);
    await waitFor(() => expect(create).toHaveBeenCalledWith({}));
  });

  it('polls the exact adopted attempt instead of following a cross-replica replacement', async () => {
    const create = vi.fn();
    const find = vi
      .fn()
      .mockResolvedValueOnce({ phase: 'exchanging', attemptId: 'attempt-1' })
      .mockResolvedValueOnce({ phase: 'success', attemptId: 'attempt-1' });
    const client = {
      service: vi.fn(() => ({ create, find })),
    } as never;

    render(<ClaudeOAuthSignIn client={client} onVerified={vi.fn()} autoStart={false} />);

    await waitFor(
      () =>
        expect(find).toHaveBeenNthCalledWith(2, {
          query: { attemptId: 'attempt-1' },
        }),
      { timeout: 2_000 }
    );
  });

  it('destroys a pasted authorization code when caller authority changes', async () => {
    const create = vi.fn();
    const find = vi
      .fn()
      .mockResolvedValueOnce({
        phase: 'awaiting_code',
        attemptId: 'attempt-admin-a',
        verificationUrl: 'https://claude.example/authorize',
      })
      .mockResolvedValueOnce({ phase: 'idle' });
    const client = {
      service: vi.fn(() => ({ create, find })),
    } as never;

    const { rerender } = render(
      <ClaudeOAuthSignIn
        client={client}
        operationScope={['admin-a']}
        onVerified={vi.fn()}
        autoStart={false}
      />
    );

    const input = await screen.findByLabelText('Claude authorization code');
    fireEvent.change(input, { target: { value: 'SECRET-CODE#STATE' } });
    expect(screen.getByDisplayValue('SECRET-CODE#STATE')).toBeInTheDocument();

    rerender(
      <ClaudeOAuthSignIn
        client={client}
        operationScope={['admin-b']}
        onVerified={vi.fn()}
        autoStart={false}
      />
    );

    await screen.findByRole('button', { name: 'Sign in with Claude' });
    expect(screen.queryByDisplayValue('SECRET-CODE#STATE')).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});
