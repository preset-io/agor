/**
 * About Tab - Display version, connection info, and system details
 */

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
  connected: boolean;
  connectionError?: string;
  isAdmin?: boolean;
}

interface HealthInfo {
  version?: string;
  database?: string;
  auth?: {
    requireAuth: boolean;
    allowAnonymous: boolean;
  };
}

export const AboutTab: React.FC<AboutTabProps> = ({
  connected,
  connectionError,
  isAdmin = false,
}) => {
  const daemonUrl = getDaemonUrl();
  const [detectionMethod, setDetectionMethod] = useState<string>('');
  const [healthInfo, setHealthInfo] = useState<HealthInfo | null>(null);

  useEffect(() => {
    console.log('[AboutTab] isAdmin:', isAdmin);

    // Determine which detection method was used
    if (import.meta.env.VITE_DAEMON_URL) {
      setDetectionMethod('Build-time env var (VITE_DAEMON_URL)');
    } else if (typeof window !== 'undefined' && window.location.pathname.startsWith('/ui')) {
      setDetectionMethod('Runtime detection (served from /ui)');
    } else {
      setDetectionMethod('Default fallback (localhost:3030)');
    }

    // Fetch health info
    fetch(`${daemonUrl}/health`)
      .then((res) => res.json())
      .then((data) => {
        console.log('[AboutTab] Health info:', data);
        setHealthInfo(data);
      })
      .catch((err) => console.error('Failed to fetch health info:', err));
  }, [daemonUrl, isAdmin]);

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
                  {healthInfo?.database && (
                    <Descriptions.Item label="Database">
                      <code>{healthInfo.database}</code>
                    </Descriptions.Item>
                  )}
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
