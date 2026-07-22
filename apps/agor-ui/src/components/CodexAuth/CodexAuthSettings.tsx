import type {
  AgenticAuthMethod,
  AgenticToolConfigField,
  AgorClient,
  AuthCheckResult,
} from '@agor-live/client';
import { Alert, Button, Segmented, Space, Typography, theme } from 'antd';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type AgenticToolFieldConfig, ApiKeyFields, type FieldStatus } from '../ApiKeyFields';
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
}: CodexAuthSettingsProps) {
  const { token } = useToken();
  const [view, setView] = useState<CodexMethodView>(() => viewForMethod(authMethod, 'chatgpt'));
  const [probe, setProbe] = useState<AuthCheckResult | null>(null);
  const [probing, setProbing] = useState(false);

  // Keep the visible sub-pane in step with the persisted method (e.g. a
  // successful device/import flips it to subscription), while preserving which
  // subscription entry point the user is looking at.
  useEffect(() => {
    setView((prev) => viewForMethod(authMethod, prev));
  }, [authMethod]);

  // A transport failure is NOT proof of a missing login — leave the prior
  // verdict untouched on error so the pane never flashes a false "not
  // connected" state (mirrors App.handleCheckAuth's fail-safe contract).
  // A monotonic generation guards against overlapping probes (a method switch
  // mid-recheck): only the latest request commits its verdict or clears the
  // spinner, so an older response can't land last and mislabel the banner.
  const probeGenRef = useRef(0);
  // Bump the generation synchronously when the client OR the effective method
  // changes (and on unmount), before any in-flight probe can resolve, and clear
  // the prior verdict. Two reasons a stale verdict must not survive a change:
  //  - client swap: an old identity's probe still owns the current generation
  //    in the window before the next probe starts (and if the replacement
  //    client is null, runProbe returns before incrementing, so the stale
  //    request would never be invalidated).
  //  - method flip: a verdict captured under the PREVIOUS method must not be
  //    re-interpreted by the banner under the new one — e.g. a rejected api-key
  //    probe becoming a false "Login not found" after a ChatGPT sign-in flips
  //    the method to subscription (and persisting there if the re-probe then
  //    fails, since transport failures keep the last verdict). Clearing to null
  //    means the banner shows nothing until a verdict for the NEW method lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: client/authMethod are the change triggers; the body invalidates rather than reading them.
  useLayoutEffect(() => {
    probeGenRef.current++;
    setProbe(null);
    setProbing(false);
    // Invalidate on unmount from the layout cleanup (synchronous, during the
    // commit) — a passive cleanup can be deferred past unmount, letting a
    // settled probe commit its verdict/spinner after teardown.
    return () => {
      probeGenRef.current++;
    };
  }, [client, authMethod]);
  const runProbe = useCallback(async () => {
    if (!client) return;
    const gen = ++probeGenRef.current;
    setProbing(true);
    try {
      const result = (await client
        .service('check-auth')
        .create({ tool: 'codex' })) as AuthCheckResult;
      if (probeGenRef.current === gen) setProbe(result);
    } catch {
      // Unknown — keep the last verdict.
    } finally {
      if (probeGenRef.current === gen) setProbing(false);
    }
  }, [client]);

  // Re-probe when the persisted method changes: the daemon checks whichever
  // credential the server's active method points at, so a verdict captured for
  // the previous method would otherwise be mislabelled by the banner.
  // biome-ignore lint/correctness/useExhaustiveDependencies: authMethod is a deliberate re-probe trigger, not a value read by runProbe.
  useEffect(() => {
    void runProbe();
  }, [runProbe, authMethod]);

  // Device sign-in and login-file import both persist `subscription` daemon-side
  // as part of the flow, so here we only re-probe to refresh the banner.
  const handleAuthenticated = useCallback(() => {
    void runProbe();
  }, [runProbe]);

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
            message="Codex is connected"
            description="A ChatGPT login is active on this server."
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
          message="Codex is connected"
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
          message="Key not working"
          description={probe.hint ?? 'Key stored but not working — enter a new one.'}
        />
      );
    }
    // 'unknown', or authenticated via a credential the stored method won't use,
    // or unset-and-empty — surface nothing (fail safe).
    return null;
  })();

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Text type="secondary">
        Personal credentials are encrypted at rest and injected only into the agent runtime.
      </Text>

      {connectionBanner && (
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {connectionBanner}
          <Button
            type="link"
            size="small"
            loading={probing}
            onClick={() => void runProbe()}
            style={{ paddingInline: 0 }}
          >
            Recheck connection
          </Button>
        </Space>
      )}

      <Segmented<CodexMethodView>
        block
        value={view}
        onChange={handleSelect}
        options={[
          { label: 'API key', value: 'api_key' },
          { label: 'Sign in with ChatGPT', value: 'chatgpt' },
          { label: 'Import login file', value: 'import' },
        ]}
      />

      {view === 'api_key' && (
        <ApiKeyFields
          tool="codex"
          fields={apiKeyFields}
          fieldStatus={fieldStatus}
          onSave={onSaveField}
          onClear={onClearField}
          saving={savingFields}
          publicValues={publicValues}
        />
      )}
      {view === 'chatgpt' && (
        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: token.marginSM }}>
            Sign in with your ChatGPT account — no OpenAI API key stored in Agor. The login is
            shared per server user, so signing in replaces any Codex login already on this server.
          </Text>
          <CodexDeviceSignIn
            client={client}
            onVerified={handleAuthenticated}
            onUseFallback={handleFallback}
            autoStart={false}
          />
        </div>
      )}
      {view === 'import' && (
        <CodexImportAuthJson client={client} onImported={handleAuthenticated} />
      )}
    </Space>
  );
}
