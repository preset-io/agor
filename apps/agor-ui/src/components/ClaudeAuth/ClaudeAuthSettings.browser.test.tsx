/** Real Chromium component proof; not a managed-app/provider end-to-end test. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { TOOL_FIELD_CONFIGS } from '../ApiKeyFields';
import { ClaudeAuthSettings } from './ClaudeAuthSettings';
import { ClaudeOAuthSignIn } from './ClaudeOAuthSignIn';

afterEach(cleanup);

it('keeps dormant backend disconnect available while operator sign-in is disabled', async () => {
  const disconnect = vi.fn(async () => ({ status: 'removed' }));
  const client = {
    service: (name: string) => ({
      create:
        name === 'claude-auth/logout' ? disconnect : vi.fn(async () => ({ status: 'unknown' })),
      find: vi.fn(async () => ({ phase: 'idle' })),
    }),
  } as never;
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <ClaudeAuthSettings
        client={client}
        authMethod="subscription"
        credentialSource="managed_oauth"
        apiKeyFields={TOOL_FIELD_CONFIGS['claude-code']}
        fieldStatus={{}}
        savingFields={{}}
        onSaveField={vi.fn(async () => {})}
        onClearField={vi.fn(async () => {})}
        allowOAuthSignIn={false}
        oauthCapability={{ available: false, storage: null, reason: 'operator_disabled' }}
      />
    </ConfigProvider>
  );
  expect(await screen.findByText(/disabled by the operator/i)).toBeInTheDocument();
  const button = await screen.findByRole('button', { name: /Disconnect/ });
  expect(button.getBoundingClientRect().width).toBeGreaterThan(0);
  fireEvent.click(button);
  await screen.findByText('Disconnect Claude login?');
  const confirm = screen
    .getAllByRole('button', { name: 'Disconnect' })
    .find((item) => item !== button)!;
  fireEvent.click(confirm);
  await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
});

it('requires current backend proof and offers recovery from a historical success', async () => {
  const verified = vi.fn();
  const client = {
    service: (name: string) =>
      name === 'claude-auth/oauth'
        ? { find: async () => ({ phase: 'success', attemptId: 'old' }), create: vi.fn() }
        : {
            create: async () => ({
              status: 'unauthenticated',
              managedOAuth: { saved: false, usable: false },
            }),
          },
  } as never;
  render(<ClaudeOAuthSignIn client={client} storage="backend" onVerified={verified} />);
  expect(await screen.findByRole('button', { name: 'Start over' })).toBeInTheDocument();
  expect(verified).not.toHaveBeenCalled();
});
