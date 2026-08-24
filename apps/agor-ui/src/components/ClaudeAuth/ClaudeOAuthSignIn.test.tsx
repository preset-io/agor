import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ClaudeOAuthSignIn } from './ClaudeOAuthSignIn';

describe('ClaudeOAuthSignIn', () => {
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
});
