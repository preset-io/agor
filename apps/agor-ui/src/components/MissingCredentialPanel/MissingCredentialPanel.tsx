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
 */

import type { AgenticToolName, AgorClient, AuthCheckResult } from '@agor-live/client';
import { AGENTIC_TOOL_DISPLAY_NAMES, AGENTIC_TOOL_KEY_CREATION_URL } from '@agor-live/client';
import { CheckCircleOutlined } from '@ant-design/icons';
import { Button, Space, Spin, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { SystemMessage } from '../SystemMessage';

const { Text, Link } = Typography;

/**
 * Tools where an existing subscription/CLI login is a real alternative to
 * pasting an API key. Mirrors the helper copy already shown in
 * `ApiKeyFields.tsx` for these tools — kept short here since the full
 * instructions live on the Settings screen this panel deep-links to.
 */
const NATIVE_AUTH_HINT: Partial<Record<AgenticToolName, string>> = {
  'claude-code': 'Already on a Claude Pro or Max plan? You can connect that instead of an API key.',
  'claude-code-cli':
    'Already on a Claude Pro or Max plan? You can connect that instead of an API key.',
  codex:
    'Already signed in with ChatGPT on this machine? Codex can use that instead of an API key.',
};

export interface MissingCredentialPanelProps {
  /** The provider this session is configured to use and needs a credential for. */
  tool: AgenticToolName;
  client?: AgorClient | null;
  /** Opens Settings deep-linked to this tool's Agentic Tools tab. Sourced from
   * `AppActionsContext` by the nearest ancestor that already consumes it
   * (`SessionPanelContent`), then threaded down as an explicit prop —
   * matching how `MessageBlock` receives `client`/`onPermissionDecision`
   * rather than reaching into context itself. */
  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;
}

export const MissingCredentialPanel: React.FC<MissingCredentialPanelProps> = ({
  tool,
  client,
  onOpenAgenticToolSettings,
}) => {
  const { token } = theme.useToken();
  const [checking, setChecking] = useState(true);
  const [authResult, setAuthResult] = useState<AuthCheckResult | null>(null);
  const [dismissed, setDismissed] = useState(false);

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
    // Re-check whenever the viewer or the tool changes; `client` identity is
    // stable per authenticated session so this effectively runs once per
    // (tool, logged-in user) pair.
  }, [client, tool]);

  const displayName = AGENTIC_TOOL_DISPLAY_NAMES[tool] ?? tool;
  const keyCreationUrl = AGENTIC_TOOL_KEY_CREATION_URL[tool];
  const nativeAuthHint = NATIVE_AUTH_HINT[tool];

  if (dismissed) return null;

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
          <Space size="small" align="start">
            <CheckCircleOutlined style={{ color: token.colorSuccess, marginTop: 2 }} />
            <Text type="secondary" style={{ fontSize: 13 }}>
              This run needed a connected {displayName} account. Your account is already connected —
              sending a new message should work.
            </Text>
          </Space>
        }
      />
    );
  }

  return (
    <SystemMessage
      content={
        <div style={{ maxWidth: 480 }}>
          <Text style={{ fontSize: 13 }}>
            Agor doesn't have its own AI model — it drives {displayName} on your behalf, so it needs
            a way to reach your account before this session can respond.
          </Text>

          <div style={{ marginTop: token.marginSM }}>
            <Button
              type="primary"
              onClick={() => onOpenAgenticToolSettings?.(tool)}
              disabled={!onOpenAgenticToolSettings}
            >
              Connect {displayName}
            </Button>
          </div>

          <Space orientation="vertical" size={4} style={{ marginTop: token.marginSM }}>
            {keyCreationUrl && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                Don't have a key yet?{' '}
                <Link href={keyCreationUrl} target="_blank" rel="noopener noreferrer">
                  Get one from {displayName}'s console →
                </Link>
              </Text>
            )}
            {nativeAuthHint && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {nativeAuthHint}
              </Text>
            )}
            <Button
              type="text"
              size="small"
              onClick={() => setDismissed(true)}
              style={{ paddingLeft: 0, color: token.colorTextTertiary }}
            >
              Not right now
            </Button>
          </Space>
        </div>
      }
    />
  );
};
