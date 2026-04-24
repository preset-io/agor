/**
 * About Tab - Display version, connection info, and system details
 */

import type { AgorClient, UnixUserMode } from '@agor-live/client';
import { Card, Descriptions, Space, Tag, Tooltip, Typography } from 'antd';
import { lazy, Suspense, useEffect, useState } from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { useConnectionState } from '../../contexts/ConnectionContext';
import { isOutOfSync } from '../../hooks/useServerVersion';

// Lazy load particles
const ParticleBackground = lazy(() =>
  import('../LoginPage/ParticleBackground').then((module) => ({
    default: module.ParticleBackground,
  }))
);

export interface AboutTabProps {
  client: AgorClient | null;
  connected: boolean;
  connectionError?: string;
  isAdmin?: boolean;
}

interface WindowWithAgorConfig extends Window {
  AGOR_DAEMON_URL?: string;
}

interface HealthInfo {
  version?: string;
  /** Build SHA from /health (canonical version signal — see setup/build-info.ts). */
  buildSha?: string;
  /** ISO timestamp from /health, may be null when SHA came from env or git. */
  builtAt?: string | null;
  database?:
    | string
    | {
        dialect: 'sqlite' | 'postgresql';
        url?: string;
        path?: string;
      };
  auth?: {
    requireAuth: boolean;
    allowAnonymous: boolean;
  };
  encryption?: {
    enabled: boolean;
    method: string | null;
  };
  execution?: {
    worktreeRbac: boolean;
    unixUserMode: UnixUserMode;
  };
  security?: {
    csp: {
      enabled: boolean;
      reportOnly: boolean;
      reportUri?: string;
      header: string;
    };
    cors: {
      mode: 'list' | 'wildcard' | 'reflect' | 'null-origin';
      credentials: boolean;
      originCount: number;
      allowSandpack: boolean;
    };
  };
}

export const AboutTab: React.FC<AboutTabProps> = ({
  client,
  connected,
  connectionError,
  isAdmin = false,
}) => {
  const daemonUrl = getDaemonUrl();
  const [detectionMethod, setDetectionMethod] = useState<string>('');
  const [healthInfo, setHealthInfo] = useState<HealthInfo | null>(null);
  // SHA captured at tab-load time (resets on hard reload). Provider-owned in
  // App.tsx via useServerVersion so this and the banner stay in lockstep.
  const { capturedSha } = useConnectionState();

  useEffect(() => {
    // Determine which detection method was used
    if ((window as WindowWithAgorConfig).AGOR_DAEMON_URL) {
      setDetectionMethod('Runtime injection (window.AGOR_DAEMON_URL)');
    } else if (import.meta.env.VITE_DAEMON_URL) {
      setDetectionMethod('Build-time env var (VITE_DAEMON_URL)');
    } else if (typeof window !== 'undefined' && window.location.pathname.startsWith('/ui')) {
      setDetectionMethod('Same-host detection (served from /ui)');
    } else {
      setDetectionMethod('Dev mode (explicit port)');
    }

    // Fetch health info using FeathersJS client
    if (client) {
      client
        .service('health')
        .find()
        .then((data) => {
          // Health endpoint returns a single object, not paginated
          const healthData = data as HealthInfo;
          setHealthInfo(healthData);
        })
        .catch((err) => console.error('Failed to fetch health info:', err));
    }
  }, [client]);

  return (
    <div style={{ position: 'relative', minHeight: 500, padding: '24px 0' }}>
      {/* Particle background */}
      <Suspense fallback={null}>
        <ParticleBackground />
      </Suspense>

      {/* Content */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <Space orientation="vertical" size="large" style={{ width: '100%' }}>
          {/* Connection Info */}
          <Card
            title="Connection Info"
            variant="borderless"
            style={{ maxWidth: 800, margin: '0 auto' }}
          >
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="Status">
                {connected ? (
                  <span style={{ color: '#52c41a' }}>✓ Connected</span>
                ) : (
                  <span style={{ color: '#ff4d4f' }}>✗ Disconnected</span>
                )}
              </Descriptions.Item>
              {connectionError && (
                <Descriptions.Item label="Error">
                  <Typography.Text type="danger">{connectionError}</Typography.Text>
                </Descriptions.Item>
              )}
              {healthInfo?.version && (
                <Descriptions.Item label="Version">{healthInfo.version}</Descriptions.Item>
              )}
              {healthInfo?.buildSha && (
                <Descriptions.Item label="Daemon Build">
                  <code>{healthInfo.buildSha}</code>
                  {healthInfo.builtAt && (
                    <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                      built {healthInfo.builtAt}
                    </Typography.Text>
                  )}
                </Descriptions.Item>
              )}
              {capturedSha && (
                <Descriptions.Item label="Tab Captured">
                  <code>{capturedSha}</code>
                  {isOutOfSync(capturedSha, healthInfo?.buildSha) && (
                    <Typography.Text type="warning" style={{ marginLeft: 8 }}>
                      ⚠️ out of sync — refresh to load the latest UI
                    </Typography.Text>
                  )}
                </Descriptions.Item>
              )}
              {healthInfo?.encryption && (
                <Descriptions.Item label="Encryption">
                  {healthInfo.encryption.enabled ? (
                    <span style={{ color: '#52c41a' }}>
                      🔐 Enabled ({healthInfo.encryption.method})
                    </span>
                  ) : (
                    <span style={{ color: '#faad14' }}>🔓 Disabled</span>
                  )}
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>

          {/* Admin-only detailed info */}
          {isAdmin && (
            <>
              {/* Daemon Config */}
              <Card
                title="Daemon Config (Admin Only)"
                variant="borderless"
                style={{ maxWidth: 800, margin: '0 auto' }}
              >
                <Descriptions column={1} bordered size="small">
                  <Descriptions.Item label="Daemon URL">
                    <code>{daemonUrl}</code>
                  </Descriptions.Item>
                  <Descriptions.Item label="Detection Method">{detectionMethod}</Descriptions.Item>
                  {healthInfo?.database &&
                    (typeof healthInfo.database === 'string' ? (
                      <Descriptions.Item label="Database">
                        <code>{healthInfo.database}</code>
                      </Descriptions.Item>
                    ) : (
                      <>
                        <Descriptions.Item label="Database Type">
                          {healthInfo.database.dialect === 'postgresql' ? (
                            <span>🐘 PostgreSQL</span>
                          ) : (
                            <span>💾 SQLite</span>
                          )}
                        </Descriptions.Item>
                        {healthInfo.database.dialect === 'postgresql' &&
                          healthInfo.database.url && (
                            <Descriptions.Item label="Database URL">
                              <code>{healthInfo.database.url}</code>
                            </Descriptions.Item>
                          )}
                        {healthInfo.database.dialect === 'sqlite' && healthInfo.database.path && (
                          <Descriptions.Item label="Database Path">
                            <code>{healthInfo.database.path}</code>
                          </Descriptions.Item>
                        )}
                      </>
                    ))}
                  {healthInfo?.auth && (
                    <>
                      <Descriptions.Item label="Authentication">
                        {healthInfo.auth.requireAuth ? '🔐 Required' : '🔓 Optional'}
                      </Descriptions.Item>
                      <Descriptions.Item label="Anonymous Access">
                        {healthInfo.auth.allowAnonymous ? '✓ Enabled' : '✗ Disabled'}
                      </Descriptions.Item>
                    </>
                  )}
                  {healthInfo?.execution && (
                    <>
                      <Descriptions.Item label="Worktree RBAC">
                        {healthInfo.execution.worktreeRbac ? (
                          <span style={{ color: '#52c41a' }}>🛡️ Enabled</span>
                        ) : (
                          <span style={{ color: '#faad14' }}>⚠️ Disabled (open access)</span>
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="Unix User Mode">
                        <code>{healthInfo.execution.unixUserMode}</code>
                        {healthInfo.execution.unixUserMode === 'simple' && (
                          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                            (no OS isolation)
                          </Typography.Text>
                        )}
                        {healthInfo.execution.unixUserMode === 'insulated' && (
                          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                            (worktree groups)
                          </Typography.Text>
                        )}
                        {healthInfo.execution.unixUserMode === 'strict' && (
                          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                            (per-user impersonation)
                          </Typography.Text>
                        )}
                      </Descriptions.Item>
                    </>
                  )}
                </Descriptions>
              </Card>

              {/* Security Headers (CSP + CORS posture) */}
              {healthInfo?.security && (
                <Card
                  title="Security Headers (Admin Only)"
                  variant="borderless"
                  style={{ maxWidth: 800, margin: '0 auto' }}
                >
                  <Descriptions column={1} bordered size="small">
                    <Descriptions.Item label="CSP">
                      {healthInfo.security.csp.enabled ? (
                        healthInfo.security.csp.reportOnly ? (
                          <Tag color="warning">Report-Only</Tag>
                        ) : (
                          <Tag color="success">Enforced</Tag>
                        )
                      ) : (
                        <Tag color="error">Disabled</Tag>
                      )}
                      {healthInfo.security.csp.reportUri && (
                        <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                          Reports → <code>{healthInfo.security.csp.reportUri}</code>
                        </Typography.Text>
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="CSP Header">
                      <Tooltip title="Full Content-Security-Policy header the daemon is emitting. If a resource is blocked, check which directive matches.">
                        <Typography.Paragraph
                          copyable={{ text: healthInfo.security.csp.header }}
                          style={{
                            margin: 0,
                            fontFamily: 'monospace',
                            fontSize: 12,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                        >
                          {healthInfo.security.csp.header}
                        </Typography.Paragraph>
                      </Tooltip>
                    </Descriptions.Item>
                    <Descriptions.Item label="CORS Mode">
                      <code>{healthInfo.security.cors.mode}</code>
                      {healthInfo.security.cors.mode === 'wildcard' && (
                        <Typography.Text type="danger" style={{ marginLeft: 8 }}>
                          ⚠️ Any origin accepted
                        </Typography.Text>
                      )}
                      {healthInfo.security.cors.mode === 'reflect' && (
                        <Typography.Text type="warning" style={{ marginLeft: 8 }}>
                          ⚠️ Origin header echoed
                        </Typography.Text>
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="CORS Credentials">
                      {healthInfo.security.cors.credentials ? (
                        <Tag color="success">Enabled</Tag>
                      ) : (
                        <Tag color="default">Disabled</Tag>
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="Allowed Origins">
                      {healthInfo.security.cors.originCount} configured{' '}
                      <Typography.Text type="secondary">
                        (+ localhost dev ports
                        {healthInfo.security.cors.allowSandpack && ', + Sandpack'})
                      </Typography.Text>
                    </Descriptions.Item>
                  </Descriptions>
                  <Typography.Paragraph
                    type="secondary"
                    style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}
                  >
                    Configure via <code>security.csp</code> and <code>security.cors</code> in{' '}
                    <code>~/.agor/config.yaml</code>. See{' '}
                    <a
                      href="https://github.com/preset-io/agor/blob/main/context/concepts/security.md"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      context/concepts/security.md
                    </a>
                    .
                  </Typography.Paragraph>
                </Card>
              )}

              {/* System Debug Info */}
              <Card
                title="System Debug Info (Admin Only)"
                variant="borderless"
                style={{ maxWidth: 800, margin: '0 auto' }}
              >
                <Descriptions column={1} bordered size="small">
                  <Descriptions.Item label="Mode">
                    {window.location.pathname.startsWith('/ui') ? (
                      <span>npm package (agor-live)</span>
                    ) : (
                      <span>Source code (dev)</span>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label="UI Location">
                    <code>{window.location.href}</code>
                  </Descriptions.Item>
                  <Descriptions.Item label="Origin">
                    <code>{window.location.origin}</code>
                  </Descriptions.Item>
                  <Descriptions.Item label="Path">
                    <code>{window.location.pathname}</code>
                  </Descriptions.Item>
                </Descriptions>
              </Card>
            </>
          )}

          {/* Links */}
          <Card
            variant="borderless"
            style={{ maxWidth: 800, margin: '0 auto', textAlign: 'center' }}
          >
            <Space size="large">
              <a href="https://github.com/preset-io/agor" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
              <a href="https://agor.live" target="_blank" rel="noopener noreferrer">
                Documentation
              </a>
            </Space>
          </Card>
        </Space>
      </div>
    </div>
  );
};
