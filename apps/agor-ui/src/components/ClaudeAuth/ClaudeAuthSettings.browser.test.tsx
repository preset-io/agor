import type { AgorClient } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { theme as antdTheme, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_FIELD_CONFIGS } from '../ApiKeyFields';
import { ClaudeAuthSettings } from './ClaudeAuthSettings';

function renderSettings(options: { allowOAuthSignIn: boolean; subscription?: boolean }) {
  const client = {
    service: vi.fn((name: string) => {
      if (name === 'check-auth') {
        return {
          create: vi.fn(async () => ({
            status: 'unknown',
            authenticated: false,
            method: 'none',
          })),
        };
      }
      if (name === 'claude-auth/logout') {
        return { create: vi.fn(async () => ({ status: 'removed' })) };
      }
      return { create: vi.fn(), find: vi.fn() };
    }),
  } as unknown as AgorClient;

  return render(
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm, token: { motion: false } }}>
      <ClaudeAuthSettings
        client={client}
        authMethod={options.subscription ? 'subscription' : 'api_key'}
        apiKeyFields={TOOL_FIELD_CONFIGS['claude-code']}
        fieldStatus={{}}
        onSaveField={vi.fn(async () => undefined)}
        onClearField={vi.fn(async () => undefined)}
        savingFields={{}}
        allowSubscriptionLogin
        allowOAuthSignIn={options.allowOAuthSignIn}
      />
    </ConfigProvider>
  );
}

afterEach(cleanup);

describe('Claude OAuth release gate (real browser)', () => {
  it('omits OAuth by default while keeping API-key, pasted-token, and cleanup controls', () => {
    renderSettings({ allowOAuthSignIn: false, subscription: true });
    expect(screen.queryByText('Sign in with Claude')).not.toBeInTheDocument();
    expect(screen.getByText('API key')).toBeVisible();
    expect(screen.getByText('Subscription token')).toBeVisible();
    expect(screen.getByText('Disconnect')).toBeVisible();
  });

  it('shows OAuth only after the advertised deployment capability is enabled', () => {
    renderSettings({ allowOAuthSignIn: true, subscription: true });
    // The authorized view exposes both the method selector and the launch
    // button; neither exists in the default-off case above.
    expect(screen.getAllByText('Sign in with Claude')).toHaveLength(2);
  });
});
