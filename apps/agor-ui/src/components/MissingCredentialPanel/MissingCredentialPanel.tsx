/**
 * MissingCredentialPanel - Connect-AI empty state
 *
 * Replaces the raw provider CLI/SDK error text ("Not logged in · Please run
 * /login") with a friendly, actionable panel when a task failed because no
 * credential resolved for the session's configured provider.
 *
 * Scoped per-viewing-user, live: the daemon only records that *some* user's
 * attempt had no credential (see `metadata.error_kind` /
 * `apps/agor-daemon/src/hooks/classify-missing-credential.ts`). Two people
 * can be looking at the same session with different credential state (one
 * connected, one not), so this component re-checks auth for whoever is
 * currently viewing it via the same `check-auth` service the onboarding
 * wizard uses, rather than trusting a stored, task-run-time snapshot.
 *
 * This panel is treated as the answer to "why didn't this respond" rather
 * than a transient notice — there is deliberately no dismiss affordance.
 *
 * Two co-equal ways to resolve it: paste a key right here (same save path
 * as Settings' own field — `onUpdateUser` with an `agentic_tools` patch,
 * see `ApiKeyFields.tsx` / `UserSettingsModal.handleToolFieldSave`), or
 * open Settings for anything needing more than a single field (native /
 * subscription auth, multiple fields, etc).
 */

import type {
  AgenticToolName,
  AgorClient,
  AuthCheckResult,
  UpdateUserInput,
} from '@agor-live/client';
import { AGENTIC_TOOL_DISPLAY_NAMES } from '@agor-live/client';
import { CheckCircleOutlined, KeyOutlined, SettingOutlined } from '@ant-design/icons';
import { Alert, Button, Divider, Input, Result, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { TOOL_FIELD_CONFIGS } from '../ApiKeyFields';
import { SystemMessage } from '../SystemMessage';

const { Text, Link } = Typography;

/**
 * Tools where an existing subscription/CLI login is a real alternative to
 * pasting an API key. Mirrors the helper copy already shown in
 * `ApiKeyFields.tsx` for these tools — kept short here since the full
 * instructions live on the Settings screen.
 */
const NATIVE_AUTH_HINT: Partial<Record<AgenticToolName, string>> = {
  'claude-code': 'Already on a Claude Pro or Max plan? Connect that instead, in Settings.',
  'claude-code-cli': 'Already on a Claude Pro or Max plan? Connect that instead, in Settings.',
  codex: 'Already signed in with ChatGPT on this machine? Codex can use that — see Settings.',
};

export interface MissingCredentialPanelProps {
  /** The provider this session is configured to use and needs a credential for. */
  tool: AgenticToolName;
  client?: AgorClient | null;
  /** Current viewer's user id — the account the inline "paste a key" save targets. */
  currentUserId?: string;
  /** Opens Settings deep-linked to this tool's Agentic Tools tab. Sourced from
   * `AppActionsContext` by the nearest ancestor that already consumes it
   * (`SessionPanelContent`), then threaded down as an explicit prop —
   * matching how `MessageBlock` receives `client`/`onPermissionDecision`
   * rather than reaching into context itself. */
  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;
  /** Saves a per-user credential field — the same `onUpdateUser` callback
   * Settings' own API-key fields already save through. Sourced and threaded
   * the same way as `onOpenAgenticToolSettings`. */
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void | Promise<void>;
}

export const MissingCredentialPanel: React.FC<MissingCredentialPanelProps> = ({
  tool,
  client,
  currentUserId,
  onOpenAgenticToolSettings,
  onUpdateUser,
}) => {
  const [checking, setChecking] = useState(true);
  const [authResult, setAuthResult] = useState<AuthCheckResult | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // `checkAuthNonce` re-triggers the effect below on demand (e.g. right
  // after a successful inline save) without duplicating the fetch logic.
  const [checkAuthNonce, setCheckAuthNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: checkAuthNonce is a sentinel dep — bumping it (e.g. after a successful inline save) intentionally re-triggers this effect without duplicating the fetch logic.
  useEffect(() => {
    let cancelled = false;
    if (!client) {
      setChecking(false);
      return;
    }
    setChecking(true);
    client
      .service('check-auth')
      .create({ tool })
      .then((result) => {
        if (!cancelled) setAuthResult(result as AuthCheckResult);
      })
      .catch(() => {
        if (!cancelled) setAuthResult(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-check whenever the viewer or the tool changes (`client` identity is
    // stable per authenticated session, so this effectively runs once per
    // (tool, logged-in user) pair) or `checkAuthNonce` is bumped manually.
  }, [client, tool, checkAuthNonce]);

  const displayName = AGENTIC_TOOL_DISPLAY_NAMES[tool] ?? tool;
  const primaryField = TOOL_FIELD_CONFIGS[tool]?.[0];
  const nativeAuthHint = NATIVE_AUTH_HINT[tool];

  const handleSaveKey = async () => {
    if (!currentUserId || !primaryField || !apiKeyValue.trim() || !onUpdateUser) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onUpdateUser(currentUserId, {
        agentic_tools: {
          [tool]: { [primaryField.field]: apiKeyValue.trim() },
        } as UpdateUserInput['agentic_tools'],
      });
      setApiKeyValue('');
      setCheckAuthNonce((n) => n + 1); // Live-refresh so a successful save flips the panel immediately.
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save that key. Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (checking) {
    return (
      <SystemMessage
        content={
          <Space size="small">
            <Spin size="small" />
            <Text type="secondary" style={{ fontSize: 13 }}>
              Checking your {displayName} connection…
            </Text>
          </Space>
        }
      />
    );
  }

  // The current viewer already has a working credential — the CTA doesn't
  // apply to them. This happens when a *different* user ran the prompt that
  // failed. No primary action needed; sending a new message runs under this
  // viewer's own (working) credential.
  if (authResult?.authenticated) {
    return (
      <SystemMessage
        content={
          <Result
            icon={<CheckCircleOutlined />}
            title={`${displayName} is connected`}
            subTitle="This run needed a connected account. Send a new message to try again."
            style={{ padding: '8px 0' }}
          />
        }
      />
    );
  }

  return (
    <SystemMessage
      content={
        <div style={{ maxWidth: 460 }}>
          <Result
            icon={<KeyOutlined />}
            title={`${displayName} isn't connected`}
            subTitle={`Agor drives ${displayName} using your own account instead of running its own model — connect it to continue.`}
            style={{ padding: '8px 0 0' }}
          />

          {primaryField && (
            <>
              <Text strong style={{ fontSize: 13 }}>
                {primaryField.label}
              </Text>
              <Space.Compact style={{ width: '100%', marginTop: 6 }}>
                <Input.Password
                  placeholder={primaryField.placeholder}
                  value={apiKeyValue}
                  onChange={(e) => setApiKeyValue(e.target.value)}
                  onPressEnter={handleSaveKey}
                  disabled={saving}
                />
                <Button
                  type="primary"
                  icon={<KeyOutlined />}
                  onClick={handleSaveKey}
                  loading={saving}
                  disabled={!apiKeyValue.trim() || !onUpdateUser || !currentUserId}
                >
                  Save
                </Button>
              </Space.Compact>
              {primaryField.docUrl && (
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  Get one from{' '}
                  <Link href={primaryField.docUrl} target="_blank" rel="noopener noreferrer">
                    {displayName}'s console →
                  </Link>
                </Text>
              )}
              {nativeAuthHint && (
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  {nativeAuthHint}
                </Text>
              )}
              {saveError && (
                <Alert type="error" message={saveError} showIcon style={{ marginTop: 8 }} />
              )}

              <Divider style={{ margin: '16px 0', fontSize: 12 }}>or</Divider>
            </>
          )}

          <Button
            block
            icon={<SettingOutlined />}
            onClick={() => onOpenAgenticToolSettings?.(tool)}
            disabled={!onOpenAgenticToolSettings}
          >
            Open Settings
          </Button>
        </div>
      }
    />
  );
};
