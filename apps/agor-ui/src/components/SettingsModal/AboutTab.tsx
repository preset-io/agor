/**
 * About Tab - Display version, connection info, and system details
 */

import type { AgorClient } from '@agor/core/api';
import { Card, Descriptions, Space, Typography } from 'antd';
import { lazy, Suspense, useEffect, useState } from 'react';
import { getDaemonUrl } from '../../config/daemon';

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

  useEffect(() => {
    console.log('[AboutTab] isAdmin:', isAdmin);
    console.log('[AboutTab] connected:', connected);

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
          console.log('[AboutTab] Health info:', data);
          // Health endpoint returns a single object, not paginated
          const healthData = data as HealthInfo;
          console.log('[AboutTab] Database info:', healthData.database);
          setHealthInfo(healthData);
        })
        .catch((err) => console.error('Failed to fetch health info:', err));
    }
  }, [client, isAdmin, connected]);

  return (
    <div style={{ position: 'relative', minHeight: 500, padding: '24px 0' }}>
      {/* Particle background */}
      <Suspense fallback={null}>
        <ParticleBackground />
      </Suspense>

      {/* Content */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
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
                </Descriptions>
              </Card>

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
