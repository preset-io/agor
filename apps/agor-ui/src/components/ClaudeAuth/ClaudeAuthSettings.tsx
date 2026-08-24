import type {
  AgenticAuthMethod,
  AgenticToolConfigField,
  AgorClient,
  AuthCheckResult,
} from '@agor-live/client';
import { Alert, Button, Form, Popconfirm, Radio, Space, Typography, theme } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIdentityGuardedAsync } from '../../hooks/useIdentityGuardedAsync';
import { type AgenticToolFieldConfig, ApiKeyFields, type FieldStatus } from '../ApiKeyFields';
import { FieldRow } from '../SettingsModal/panelPrimitives';
import { ClaudeOAuthSignIn } from './ClaudeOAuthSignIn';

const { Text } = Typography;
const { useToken } = theme;

/**
 * Which sub-pane the management surface is showing. The persisted auth method is
 * only two-valued (`api_key` | `subscription`); the OAuth sign-in and a pasted
 * subscription token both land `subscription`, so the two subscription entry
 * points are distinguished here as a local view choice.
 */
type ClaudeMethodView = 'api_key' | 'oauth' | 'token';

function viewForMethod(method: AgenticAuthMethod, prev: ClaudeMethodView): ClaudeMethodView {
  if (method === 'api_key') return 'api_key';
  return prev === 'token' ? 'token' : 'oauth';
}

export interface ClaudeAuthSettingsProps {
  client: AgorClient | null;
  /**
   * Persisted Claude auth method for this user. Read-only here: the method is a
   * consequence of the credential you configure (saving an API key flips it to
   * `api_key`; a completed OAuth sign-in / pasted subscription token flips it to
   * `subscription`), never of merely selecting a tab.
   */
  authMethod: AgenticAuthMethod;
  /** All Claude credential field definitions (API key, subscription token, advanced). */
  apiKeyFields: AgenticToolFieldConfig[];
  fieldStatus: FieldStatus;
  onSaveField: (field: AgenticToolConfigField, value: string) => Promise<void>;
  onClearField: (field: AgenticToolConfigField) => Promise<void>;
  savingFields: Partial<Record<AgenticToolConfigField, boolean>>;
  publicValues?: Partial<Record<AgenticToolConfigField, string>>;
  /**
   * Whether the OAuth sign-in / disconnect / connection-probe controls are
   * available. They act on the *caller's* own login (a server-scoped
   * credentials.json + `check-auth`/`claude-auth/logout`), never on
   * `onSaveField`'s target user — so an admin editing someone else must not see
   * them. Defaults to true (self-editing).
   */
  allowSubscriptionLogin?: boolean;
}

/**
 * Claude authentication management pane — the three ways in (API key, Claude
 * subscription OAuth sign-in, pasted subscription token) plus a live connection
 * probe and a disconnect. Mirrors the Codex pane: selecting a tab is a pure view
 * switch, and the effective method follows the credential you actually configure.
 */
export function ClaudeAuthSettings({
  client,
  authMethod,
  apiKeyFields,
  fieldStatus,
  onSaveField,
  onClearField,
  savingFields,
  publicValues,
  allowSubscriptionLogin = true,
}: ClaudeAuthSettingsProps) {
  const { token } = useToken();
  const [view, setView] = useState<ClaudeMethodView>(() => viewForMethod(authMethod, 'oauth'));
  const [probe, setProbe] = useState<AuthCheckResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const apiKeyOnlyFields = useMemo(
    () => apiKeyFields.filter((config) => config.field !== 'CLAUDE_CODE_OAUTH_TOKEN'),
    [apiKeyFields]
  );
  const tokenFields = useMemo(
    () => apiKeyFields.filter((config) => config.field === 'CLAUDE_CODE_OAUTH_TOKEN'),
    [apiKeyFields]
  );

  // Only PROMOTE to a subscription view when the method becomes subscription;
  // never demote to api_key. After a disconnect (method → api_key) the user
  // stays on the sign-in view showing the signed-out state instead of jumping.
  useEffect(() => {
    if (authMethod === 'subscription') {
      setView((prev) => (prev === 'token' || !allowSubscriptionLogin ? 'token' : 'oauth'));
    }
  }, [authMethod, allowSubscriptionLogin]);

  // An administrator editing another user cannot invoke the caller-bound OAuth
  // endpoints, but must still be able to manage that user's pasted subscription
  // token. Keep only the native OAuth tab self-only.
  const visibleView = !allowSubscriptionLogin && view === 'oauth' ? 'token' : view;

  // Invalidate an in-flight probe and clear the prior verdict whenever the client
  // OR the effective method changes (and on unmount) — a verdict captured under
  // the PREVIOUS method must not be re-interpreted under the new one.
  const { run } = useIdentityGuardedAsync([client, authMethod], () => {
    setProbe(null);
    setProbing(false);
  });
  const runProbe = useCallback(async () => {
    if (!client || !allowSubscriptionLogin) return;
    setProbing(true);
    try {
      const result = await run(
        () =>
          client
            .service('check-auth')
            .create({ tool: 'claude-code', validateNative: true }) as Promise<AuthCheckResult>
      );
      setProbe(result);
    } catch {
      // A transport failure is NOT proof of a missing login — keep the last
      // verdict so the pane never flashes a false "not connected" state.
    } finally {
      setProbing(false);
    }
  }, [client, run, allowSubscriptionLogin]);

  // API-key validation is cheap; native subscription validation may schedule a
  // Cloud executor, so it runs only via Recheck or immediately after sign-in.
  useEffect(() => {
    if (authMethod === 'api_key') void runProbe();
  }, [authMethod, runProbe]);

  // OAuth sign-in returns success only after the daemon has written and
  // executor-verified the credentials file — adopt that directly.
  const handleAuthenticated = useCallback(() => {
    setProbing(false);
    setProbe({
      status: 'authenticated',
      authenticated: true,
      method: 'oauth',
      hint: 'Claude subscription login connected.',
    });
  }, []);

  // Remove the Claude login from this server (delete-only, no token revocation).
  // The daemon deletes credentials.json and clears the stored token + method,
  // which arrives as a user patch; the pane re-syncs to the disconnected state
  // and re-probes on its own.
  const handleRemoveLogin = useCallback(async () => {
    if (!client) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await client.service('claude-auth/logout').create({});
    } catch (err) {
      setRemoveError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not remove the Claude login — try again.'
      );
    } finally {
      setRemoving(false);
    }
  }, [client]);

  const handleSelect = useCallback((next: ClaudeMethodView) => {
    setView(next);
  }, []);

  // The banner reflects the EFFECTIVE auth — the persisted method plus a probe of
  // that method's credential — never the currently-viewed tab. A "connected"
  // verdict shows only when the probe exercised the stored method.
  const connectionBanner = (() => {
    if (!probe) return null;
    const authenticated = probe.status === 'authenticated';
    const unauthenticated = probe.status === 'unauthenticated';
    if (authMethod === 'subscription') {
      if (authenticated && probe.method !== 'api-key') {
        return (
          <Alert
            type="success"
            showIcon
            message="Claude is connected"
            description="A Claude subscription login is active on this server."
          />
        );
      }
      if (unauthenticated) {
        return (
          <Alert
            type="error"
            showIcon
            message="Login not found"
            description={
              probe.hint ??
              'Claude login no longer found on this server — sign in with Claude again.'
            }
          />
        );
      }
      return null;
    }
    if (authenticated && probe.method === 'api-key') {
      return (
        <Alert
          type="success"
          showIcon
          message="Claude is connected"
          description="Your Anthropic API key is working."
        />
      );
    }
    if (unauthenticated && fieldStatus.ANTHROPIC_API_KEY) {
      return (
        <Alert
          type="error"
          showIcon
          message="Key not working"
          description={probe.hint ?? 'Key stored but not working — enter a new one.'}
        />
      );
    }
    return null;
  })();

  return (
    <Form component={false} layout="vertical">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Text type="secondary">
          API keys and pasted tokens are encrypted at rest. Claude sign-in uses a private credential
          file in the execution home.
        </Text>

        {allowSubscriptionLogin && (connectionBanner || authMethod === 'subscription') && (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {connectionBanner}
            <Space size="middle" wrap>
              <Button
                type="link"
                size="small"
                loading={probing}
                onClick={() => void runProbe()}
                style={{ paddingInline: 0 }}
              >
                Recheck connection
              </Button>
              {/* Disconnect applies only to a subscription login; API keys use ApiKeyFields' Clear. */}
              {authMethod === 'subscription' && (
                <Popconfirm
                  title="Disconnect Claude login?"
                  description={
                    <div style={{ maxWidth: 340 }}>
                      Signs Claude out on this server only — your other devices stay signed in. In
                      shared-identity setups this is one login for the whole server, so removing it
                      disconnects Claude for everyone on it. To revoke this login everywhere, use
                      your Claude account settings or run <Text code>/logout</Text> on a machine
                      where you're signed in.
                    </div>
                  }
                  okText="Disconnect"
                  okButtonProps={{ danger: true, loading: removing }}
                  cancelText="Keep login"
                  onConfirm={handleRemoveLogin}
                >
                  <Button
                    type="link"
                    size="small"
                    danger
                    loading={removing}
                    style={{ paddingInline: 0 }}
                  >
                    Disconnect
                  </Button>
                </Popconfirm>
              )}
            </Space>
            {removeError && (
              <Alert
                type="error"
                showIcon
                message={removeError}
                style={{ fontSize: token.fontSizeSM }}
              />
            )}
          </Space>
        )}

        <FieldRow label="Sign-in method" style={{ marginBottom: 0 }}>
          <Radio.Group
            buttonStyle="solid"
            value={visibleView}
            onChange={(event) => handleSelect(event.target.value as ClaudeMethodView)}
          >
            <Radio.Button value="api_key">API key</Radio.Button>
            {allowSubscriptionLogin && (
              <Radio.Button value="oauth">Sign in with Claude</Radio.Button>
            )}
            <Radio.Button value="token">Subscription token</Radio.Button>
          </Radio.Group>
        </FieldRow>

        {visibleView === 'api_key' && (
          <ApiKeyFields
            tool="claude-code"
            fields={apiKeyOnlyFields}
            fieldStatus={fieldStatus}
            onSave={onSaveField}
            onClear={onClearField}
            saving={savingFields}
            publicValues={publicValues}
          />
        )}
        {allowSubscriptionLogin && view === 'oauth' && (
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: token.marginSM }}>
              Sign in with your Claude subscription — Agor stores the login on the server, no token
              to copy. The login is shared per server user, so signing in replaces any Claude login
              already on this server.
            </Text>
            <ClaudeOAuthSignIn
              client={client}
              connected={authMethod === 'subscription'}
              onVerified={handleAuthenticated}
              autoStart={false}
            />
          </div>
        )}
        {visibleView === 'token' && (
          <ApiKeyFields
            tool="claude-code"
            fields={tokenFields}
            fieldStatus={fieldStatus}
            onSave={onSaveField}
            onClear={onClearField}
            saving={savingFields}
            publicValues={publicValues}
          />
        )}
      </Space>
    </Form>
  );
}
