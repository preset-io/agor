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
  /** Persisted Codex auth method for this user. */
  authMethod: AgenticAuthMethod;
  /** Persist a new auth method (flips `agentic_auth_methods.codex`). */
  onAuthMethodChange: (method: AgenticAuthMethod) => void | Promise<void>;
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
  onAuthMethodChange,
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
  // Bump the generation synchronously when the client changes (and on unmount),
  // before any in-flight probe can resolve. Without this an old client's probe
  // still owns the current generation in the window before the next probe
  // starts — and if the replacement client is null, runProbe returns before
  // incrementing, so the stale request would never be invalidated. Clear the
  // prior verdict so one identity's status is never shown for another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: client is the change trigger; the body invalidates rather than reading it.
  useLayoutEffect(() => {
    probeGenRef.current++;
    setProbe(null);
    setProbing(false);
  }, [client]);
  useEffect(
    () => () => {
      probeGenRef.current++;
    },
    []
  );
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

  const handleFallback = useCallback(
    (target: CodexAuthFallback) => {
      if (target === 'import') {
        setView('import');
        return;
      }
      setView('api_key');
      if (authMethod !== 'api_key') void onAuthMethodChange('api_key');
    },
    [authMethod, onAuthMethodChange]
  );

  const handleSelect = useCallback(
    (next: CodexMethodView) => {
      setView(next);
      // "Sign in with ChatGPT" and "Import login file" are local views only —
      // the daemon device/import flows persist `subscription` themselves once
      // they succeed. Persisting it on mere selection would deactivate a working
      // API key before any ChatGPT login exists (surfacing a false "Login not
      // found"). Only deliberately choosing the API-key method flips it back.
      if (next === 'api_key' && authMethod !== 'api_key') void onAuthMethodChange('api_key');
    },
    [authMethod, onAuthMethodChange]
  );

  const connectionBanner = (() => {
    if (!probe) return null;
    if (probe.status === 'authenticated') {
      return (
        <Alert
          type="success"
          showIcon
          message="Codex is connected"
          description={
            authMethod === 'subscription'
              ? 'A ChatGPT login is active on this server.'
              : 'Your OpenAI API key is working.'
          }
        />
      );
    }
    if (probe.status === 'unauthenticated') {
      if (authMethod === 'subscription') {
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
      // API-key method: only a stored-but-rejected key is a problem worth
      // flagging; an empty key just means the user hasn't set one yet.
      if (fieldStatus.OPENAI_API_KEY) {
        return (
          <Alert
            type="error"
            showIcon
            message="Key not working"
            description={probe.hint ?? 'Key stored but not working — enter a new one.'}
          />
        );
      }
    }
    // 'unknown' or unset-and-empty — surface nothing (fail safe).
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
