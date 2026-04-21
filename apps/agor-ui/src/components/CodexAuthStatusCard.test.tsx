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

    expect(screen.getByRole('button', { name: 'Connect Codex' })).toBeVisible();
  });

  it('shows API key override warning when native auth is masked by OPENAI_API_KEY', () => {
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

    expect(screen.getByText(/will take precedence/i)).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'Cancel login' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
