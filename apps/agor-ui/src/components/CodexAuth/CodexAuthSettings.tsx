import type {
  AgenticAuthMethod,
  AgenticToolConfigField,
  AgorClient,
  AuthCheckResult,
} from '@agor-live/client';
import { Alert, Button, Form, Popconfirm, Radio, Space, Typography, theme } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useIdentityGuardedAsync } from '../../hooks/useIdentityGuardedAsync';
import { type AgenticToolFieldConfig, ApiKeyFields, type FieldStatus } from '../ApiKeyFields';
import { FieldRow } from '../SettingsModal/panelPrimitives';
import { type CodexAuthFallback, CodexDeviceSignIn } from './CodexDeviceSignIn';
import { CodexImportAuthJson } from './CodexImportAuthJson';

const { Text } = Typography;
const { useToken } = theme;

/**
 * Which sub-pane the management surface is showing. The persisted auth method is
 * only two-valued (`api_key` | `subscription`) because "sign in with ChatGPT"
 * and "import auth.json" both land the same server-side ChatGPT login — so the
 * two subscription entry points are distinguished here as a local view choice.
 */
type CodexMethodView = 'api_key' | 'chatgpt' | 'import';

function viewForMethod(method: AgenticAuthMethod, prev: CodexMethodView): CodexMethodView {
  if (method === 'api_key') return 'api_key';
  return prev === 'import' ? 'import' : 'chatgpt';
}

export interface CodexAuthSettingsProps {
  client: AgorClient | null;
  /**
   * Persisted Codex auth method for this user. Read-only here: the method is a
   * consequence of the credential you configure (saving an OpenAI key flips it
   * to `api_key`; a completed device sign-in / import flips it to
   * `subscription` daemon-side), never of merely selecting a tab — so switching
   * views can't silently deactivate a working login.
   */
  authMethod: AgenticAuthMethod;
  /** Codex credential field definitions (OpenAI key + base URL). */
  apiKeyFields: AgenticToolFieldConfig[];
  /** Per-field set/unset flags for the API-key pane. */
  fieldStatus: FieldStatus;
  onSaveField: (field: AgenticToolConfigField, value: string) => Promise<void>;
  onClearField: (field: AgenticToolConfigField) => Promise<void>;
  savingFields: Partial<Record<AgenticToolConfigField, boolean>>;
  publicValues?: Partial<Record<AgenticToolConfigField, string>>;
  /**
   * Whether the ChatGPT sign-in / import-login-file / connection-probe controls
   * are available. These act on the *caller's* machine login (a server-scoped
   * auth.json + `check-auth`/`codex-auth/logout`), never on `onSaveField`'s
   * target user — so an admin editing someone else must not see them (they would
   * mutate the admin's own Codex login). Defaults to true (self-editing). When
   * false, only the API-key path is shown, and it still targets the edited user.
   */
  allowChatgptLogin?: boolean;
  identityKey?: string | null;
  operationScope?: readonly unknown[] | null;
}

/**
 * Codex authentication management pane — the three ways in (API key, ChatGPT
 * device sign-in, imported login file) plus a live connection probe. Unlike the
 * onboarding wizard, this is a management view: re-signing-in or re-importing
 * stays reachable while connected, and a stored-but-broken credential surfaces
 * as a prominent error rather than being hidden behind a "connected" collapse.
 */
export function CodexAuthSettings({
  client,
  authMethod,
  apiKeyFields,
  fieldStatus,
  onSaveField,
  onClearField,
  savingFields,
  publicValues,
  allowChatgptLogin = true,
  identityKey,
  operationScope,
}: CodexAuthSettingsProps) {
  const { token } = useToken();
  const [view, setView] = useState<CodexMethodView>(() => viewForMethod(authMethod, 'chatgpt'));
  const [probe, setProbe] = useState<AuthCheckResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Keep the visible sub-pane in step with the persisted method (e.g. a
  // successful device/import flips it to subscription), while preserving which
  // subscription entry point the user is looking at.
  useEffect(() => {
    setView((prev) => viewForMethod(authMethod, prev));
  }, [authMethod]);

  // Invalidate an in-flight probe — and clear the prior verdict — whenever the
  // client OR the effective method changes (and on unmount). Two reasons a
  // stale verdict must not survive a change:
  //  - client swap: an old identity's probe must not land its verdict over the
  //    replacement's, nor call setState after teardown.
  //  - method flip: a verdict captured under the PREVIOUS method must not be
  //    re-interpreted by the banner under the new one — e.g. a rejected api-key
  //    probe becoming a false "Login not found" after a ChatGPT sign-in flips
  //    the method to subscription (and persisting there if the re-probe then
  //    fails, since transport failures keep the last verdict). Clearing to null
  //    means the banner shows nothing until a verdict for the NEW method lands.
  const effectiveOperationScope =
    operationScope === undefined ? ([client, authMethod] as const) : operationScope;
  const operationAvailable = effectiveOperationScope !== null;
  const { run } = useIdentityGuardedAsync(
    [client, authMethod, ...(effectiveOperationScope ?? [null])],
    () => {
      setProbe(null);
      setProbing(false);
    }
  );
  const runProbe = useCallback(async () => {
    // The probe checks the caller's own login; skip it entirely when the
    // caller-scoped controls are hidden (admin editing another user).
    if (!client || !allowChatgptLogin || !operationAvailable) return;
    setProbing(true);
    try {
      const result = await run(
        () =>
          client
            .service('check-auth')
            .create({ tool: 'codex', validateNative: true }) as Promise<AuthCheckResult>
      );
      setProbe(result);
    } catch {
      // A transport failure is NOT proof of a missing login — keep the last
      // verdict so the pane never flashes a false "not connected" state
      // (mirrors App.handleCheckAuth's fail-safe contract).
    } finally {
      setProbing(false);
    }
  }, [client, run, allowChatgptLogin, operationAvailable]);

  // API-key validation is cheap and stays local to the daemon/provider. Native
  // subscription validation may require scheduling a Cloud executor, so it is
  // only run by the explicit Recheck action or immediately after login/import.
  useEffect(() => {
    if (authMethod === 'api_key') void runProbe();
  }, [authMethod, runProbe]);

  // Device sign-in and login-file import already return success only after the
  // daemon has written and executor-verified auth.json. Adopt that result
  // directly instead of scheduling a second executor merely to rediscover the
  // file we just wrote. Later validation remains available through Recheck.
  const handleAuthenticated = useCallback(() => {
    setProbing(false);
    setProbe({
      status: 'authenticated',
      authenticated: true,
      method: 'oauth',
      hint: 'ChatGPT login connected.',
    });
  }, []);

  // Remove the Codex ChatGPT login from this server (delete-only, no token
  // revocation). The daemon deletes the auth.json and clears the stored method —
  // which arrives as a user patch that flips authMethod to the api_key default,
  // so the pane re-syncs to the disconnected state and re-probes on its own (no
  // local state to reset here).
  const handleRemoveLogin = useCallback(async () => {
    if (!client || !operationAvailable) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await run(() => client.service('codex-auth/logout').create({}));
    } catch (err) {
      setRemoveError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not remove the Codex login — try again.'
      );
    } finally {
      setRemoving(false);
    }
  }, [client, operationAvailable, run]);

  // Selecting a method is a pure view switch — it never persists the auth
  // method. Persisting on selection is destructive in BOTH directions: choosing
  // a subscription view would deactivate a working API key before a ChatGPT
  // login exists, and choosing "API key" would deactivate a working ChatGPT
  // login before any key is stored (a silent, non-undoable break). The method
  // instead follows the credential you actually configure — saving a key flips
  // it to api_key; a completed device/import flips it to subscription.
  const handleFallback = useCallback((target: CodexAuthFallback) => {
    setView(target === 'import' ? 'import' : 'api_key');
  }, []);

  const handleSelect = useCallback((next: CodexMethodView) => {
    setView(next);
  }, []);

  // The banner reflects the EFFECTIVE auth — the persisted method plus a probe
  // of that method's credential — never the currently-viewed tab. Crucially, a
  // "connected" verdict is only shown when the probe actually exercised the
  // stored method: an authenticated api-key probe can't render "ChatGPT login
  // active" and an authenticated login probe can't render "API key working".
  // This makes the sessions-broken-but-banner-says-connected contradiction
  // impossible even if the daemon's probe ever reported a credential the
  // executor wouldn't use for the stored method.
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
            title="Codex is connected"
            description="A ChatGPT login is active on this server."
          />
        );
      }
      if (unauthenticated) {
        return (
          <Alert
            type="error"
            showIcon
            title="Login not found"
            description={
              probe.hint ??
              'Codex login no longer found on this server — sign in with ChatGPT or import it again.'
            }
          />
        );
      }
      return null;
    }
    // authMethod === 'api_key': the effective credential is the OpenAI key.
    if (authenticated && probe.method === 'api-key') {
      return (
        <Alert
          type="success"
          showIcon
          title="Codex is connected"
          description="Your OpenAI API key is working."
        />
      );
    }
    // Only a stored-but-rejected key is worth flagging; an empty key just means
    // the user hasn't set one yet (and a login on disk is irrelevant here —
    // sessions use the api_key method, not that login).
    if (unauthenticated && fieldStatus.OPENAI_API_KEY) {
      return (
        <Alert
          type="error"
          showIcon
          title="Key not working"
          description={probe.hint ?? 'Key stored but not working — enter a new one.'}
        />
      );
    }
    // 'unknown', or authenticated via a credential the stored method won't use,
    // or unset-and-empty — surface nothing (fail safe).
    return null;
  })();

  return (
    <Form component={false} layout="vertical">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Text type="secondary">
          Personal credentials are encrypted at rest and injected only into the agent runtime.
        </Text>

        {allowChatgptLogin && (connectionBanner || authMethod === 'subscription') && (
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
              {/* Removal applies only to a ChatGPT login; API keys use ApiKeyFields' Clear. */}
              {authMethod === 'subscription' && (
                <Popconfirm
                  title="Remove Codex login?"
                  description={
                    <div style={{ maxWidth: 340 }}>
                      Signs Codex out on this server only — your other devices stay signed in. In
                      shared-identity setups this is one login for the whole server, so removing it
                      disconnects Codex for everyone on it. To revoke this login everywhere, use
                      ChatGPT's security settings or run <Text code>codex logout</Text> on a machine
                      where you're signed in.
                    </div>
                  }
                  okText="Remove"
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
                    Remove login
                  </Button>
                </Popconfirm>
              )}
            </Space>
            {removeError && (
              <Alert
                type="error"
                showIcon
                title={removeError}
                style={{ fontSize: token.fontSizeSM }}
              />
            )}
          </Space>
        )}

        {allowChatgptLogin && (
          <FieldRow
            label="Sign-in method"
            help="Switching here only changes which option is shown. Your active method updates when you save an API key or finish a ChatGPT sign-in or import."
            style={{ marginBottom: 0 }}
          >
            <Radio.Group
              buttonStyle="solid"
              value={view}
              onChange={(event) => handleSelect(event.target.value as CodexMethodView)}
            >
              <Radio.Button value="api_key">API key</Radio.Button>
              <Radio.Button value="chatgpt">Sign in with ChatGPT</Radio.Button>
              <Radio.Button value="import">Import login file</Radio.Button>
            </Radio.Group>
          </FieldRow>
        )}

        {(!allowChatgptLogin || view === 'api_key') && (
          <ApiKeyFields
            identityKey={identityKey ?? 'standalone-codex'}
            operationScope={effectiveOperationScope}
            tool="codex"
            fields={apiKeyFields}
            fieldStatus={fieldStatus}
            onSave={onSaveField}
            onClear={onClearField}
            saving={savingFields}
            publicValues={publicValues}
          />
        )}
        {allowChatgptLogin && view === 'chatgpt' && (
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: token.marginSM }}>
              Sign in with your ChatGPT account — no OpenAI API key stored in Agor. The login is
              shared per server user, so signing in replaces any Codex login already on this server.
            </Text>
            <CodexDeviceSignIn
              client={client}
              operationScope={effectiveOperationScope}
              onVerified={handleAuthenticated}
              onUseFallback={handleFallback}
              autoStart={false}
            />
          </div>
        )}
        {allowChatgptLogin && view === 'import' && (
          <CodexImportAuthJson
            client={client}
            identityKey={identityKey}
            operationScope={effectiveOperationScope}
            onImported={handleAuthenticated}
          />
        )}
      </Space>
    </Form>
  );
}
