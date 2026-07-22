/**
 * Connect-AI empty state shown in place of a raw provider auth error. Because
 * the stored classification reflects whoever ran the failed prompt, the panel
 * re-checks auth live for the current viewer via the `check-auth` service.
 */

import type { AgenticToolName, AgorClient, AuthCheckResult } from '@agor-live/client';
import { AGENTIC_TOOL_DISPLAY_NAMES, AGENTIC_TOOL_KEY_CREATION_URL } from '@agor-live/client';
import { CheckCircleOutlined } from '@ant-design/icons';
import { Button, Space, Spin, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { SystemMessage } from '../SystemMessage';

const { Text, Link } = Typography;

/** Tools where an existing subscription/CLI login is a real alternative to an API key. */
const NATIVE_AUTH_HINT: Partial<Record<AgenticToolName, string>> = {
  'claude-code': 'Already on a Claude Pro or Max plan? You can connect that instead of an API key.',
  'claude-code-cli':
    'Already on a Claude Pro or Max plan? You can connect that instead of an API key.',
  codex:
    'Already signed in with ChatGPT on this machine? Codex can use that instead of an API key.',
};

const pendingAuthChecks = new WeakMap<
  AgorClient,
  Map<AgenticToolName, Promise<AuthCheckResult | null>>
>();

function checkAuth(client: AgorClient, tool: AgenticToolName): Promise<AuthCheckResult | null> {
  let checksByTool = pendingAuthChecks.get(client);
  if (!checksByTool) {
    checksByTool = new Map();
    pendingAuthChecks.set(client, checksByTool);
  }

  const existing = checksByTool.get(tool);
  if (existing) return existing;

  const request = Promise.resolve(client.service('check-auth').create({ tool }))
    .then((result) => result as AuthCheckResult)
    .catch(() => null);
  checksByTool.set(tool, request);
  void request.finally(() => {
    if (checksByTool?.get(tool) === request) checksByTool.delete(tool);
  });
  return request;
}

export interface MissingCredentialPanelProps {
  tool: AgenticToolName;
  client?: AgorClient | null;
  /** Opens Settings deep-linked to this tool's Agentic Tools tab. */
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

  useEffect(() => {
    let cancelled = false;
    if (!client) {
      setChecking(false);
      return;
    }
    setChecking(true);
    checkAuth(client, tool)
      .then((result) => {
        if (!cancelled) setAuthResult(result);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, tool]);

  const displayName = AGENTIC_TOOL_DISPLAY_NAMES[tool] ?? tool;
  const keyCreationUrl = AGENTIC_TOOL_KEY_CREATION_URL[tool];
  const nativeAuthHint = NATIVE_AUTH_HINT[tool];

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

  // Current viewer already has a working credential — no CTA needed.
  if (authResult?.status === 'authenticated') {
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

  if (authResult?.status !== 'unauthenticated') {
    return (
      <SystemMessage
        content={
          <Space orientation="vertical" size="small">
            <Text type="secondary" style={{ fontSize: 13 }}>
              Agor couldn't verify your {displayName} connection. Try sending a new message. If it
              still fails, check the connection in Settings.
            </Text>
            <Button
              size="small"
              onClick={() => onOpenAgenticToolSettings?.(tool)}
              disabled={!onOpenAgenticToolSettings}
            >
              Check {displayName} settings
            </Button>
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
                <Link
                  href={keyCreationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 12 }}
                >
                  Get one from {displayName}'s console →
                </Link>
              </Text>
            )}
            {nativeAuthHint && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {nativeAuthHint}
              </Text>
            )}
          </Space>
        </div>
      }
    />
  );
};
