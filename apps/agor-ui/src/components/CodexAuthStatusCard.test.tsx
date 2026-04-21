import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexAuthStatusCard } from './CodexAuthStatusCard';

describe('CodexAuthStatusCard', () => {
  it('shows Connect Codex when status is not connected', () => {
    render(
      <CodexAuthStatusCard
        status={{
          status: 'not_signed_in',
          label: 'Not signed in',
          description: 'Codex is not connected yet.',
          warnings: [],
          guidance: [],
          codexHome: '/tmp/.agor/codex/users/user-123',
          credentialStore: 'file',
          unixUserMode: 'simple',
          executionUnixUser: null,
        }}
        onConnect={vi.fn()}
      />
    );

    expect(
      screen.getByText('Connect Codex to use your ChatGPT subscription in Agor.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Codex' })).toBeVisible();
  });

  it('shows a compact API key override warning when native auth is masked by OPENAI_API_KEY', () => {
    render(
      <CodexAuthStatusCard
        status={{
          status: 'using_api_key',
          label: 'Using API key',
          description:
            'A user-specific OPENAI_API_KEY is configured and overrides native Codex auth.',
          warnings: [],
          guidance: [],
          codexHome: '/tmp/.agor/codex/users/user-123',
          credentialStore: 'file',
          unixUserMode: 'simple',
          executionUnixUser: null,
          apiKeySource: 'user',
        }}
      />
    );

    expect(screen.getByText('Using OpenAI API key')).toBeInTheDocument();
    expect(screen.getByText(/remove the configured openai_api_key/i)).toBeInTheDocument();
    expect(screen.queryByText(/stable codex home/i)).not.toBeInTheDocument();
  });

  it('shows the device auth instructions while a flow is pending', () => {
    const onCancel = vi.fn();

    render(
      <CodexAuthStatusCard
        status={{
          status: 'not_signed_in',
          label: 'Not signed in',
          description: 'Codex is not connected yet.',
          warnings: [],
          guidance: [],
          codexHome: '/tmp/.agor/codex/users/user-123',
          credentialStore: 'file',
          unixUserMode: 'simple',
          executionUnixUser: null,
        }}
        flow={{
          flowId: 'flow-1',
          agorUserId: 'user-123',
          status: 'pending',
          verificationUri: 'https://chatgpt.com/device',
          userCode: 'ABCD-EFGHI',
          codexHome: '/tmp/.agor/codex/users/user-123',
          executionUnixUser: null,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }}
        onCancel={onCancel}
      />
    );

    expect(screen.getByText('Complete login in your browser')).toBeInTheDocument();
    expect(screen.getByText('https://chatgpt.com/device')).toBeInTheDocument();
    expect(screen.getByText('ABCD-EFGHI')).toBeInTheDocument();
    expect(screen.getByText(/open the verification url/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel login' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows disconnect controls when Codex is already connected', () => {
    const onDisconnect = vi.fn();

    render(
      <CodexAuthStatusCard
        status={{
          status: 'signed_in_with_chatgpt',
          label: 'Signed in with ChatGPT',
          description: 'Codex is connected for this user.',
          warnings: [],
          guidance: [],
          codexHome: '/tmp/.agor/codex/users/user-123',
          credentialStore: 'file',
          unixUserMode: 'simple',
          executionUnixUser: null,
        }}
        onReconnect={vi.fn()}
        onDisconnect={onDisconnect}
      />
    );

    expect(screen.getByText('Connected to Codex')).toBeInTheDocument();
    expect(
      screen.getByText('This user can use Codex with their ChatGPT subscription.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Codex' }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('does not show backend diagnostic details in the default card', () => {
    render(
      <CodexAuthStatusCard
        status={{
          status: 'unknown',
          label: 'Unknown / needs verification',
          description:
            'Agor could not verify native Codex auth from the current per-user Codex home.',
          warnings: ['No file-backed Codex auth was detected. Keyring-backed auth may still work.'],
          guidance: ['Run codex login.'],
          codexHome: '/tmp/.agor/codex/users/user-123',
          credentialStore: 'unknown',
          unixUserMode: 'simple',
          executionUnixUser: null,
        }}
        onConnect={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Connect Codex' })).toBeVisible();
    expect(screen.queryByText('Unknown / needs verification')).not.toBeInTheDocument();
    expect(screen.queryByText(/run codex login/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stable codex home/i)).not.toBeInTheDocument();
  });
});
