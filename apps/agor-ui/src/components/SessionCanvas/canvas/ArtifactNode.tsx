/**
 * ArtifactNode — Board canvas node for live Sandpack artifacts
 *
 * Fetches artifact payload from the daemon REST API, renders via Sandpack,
 * captures console events, and reloads on content_hash changes.
 */

// Polyfill crypto.subtle for non-secure contexts (HTTP).
// Sandpack uses crypto.subtle.digest() to generate short IDs, which is only
// available in secure contexts (HTTPS/localhost). On plain HTTP, we provide
// a simple fallback using Math.random.
if (typeof globalThis.crypto !== 'undefined' && !globalThis.crypto.subtle) {
  // biome-ignore lint/suspicious/noExplicitAny: minimal polyfill for Sandpack compatibility
  (globalThis.crypto as any).subtle = {
    async digest(_algo: string, data: ArrayBuffer) {
      // Simple hash fallback — not cryptographically secure, only used for Sandpack IDs
      const bytes = new Uint8Array(data);
      let hash = 0;
      for (const b of bytes) {
        hash = (hash * 31 + b) | 0;
      }
      const result = new ArrayBuffer(4);
      new DataView(result).setInt32(0, hash);
      return result;
    },
  };
}

import type {
  ArtifactBoardObject,
  ArtifactID,
  ArtifactPayload,
  BoardObject,
} from '@agor/core/types';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { SandpackPreview, SandpackProvider, useSandpackConsole } from '@codesandbox/sandpack-react';
import { Badge, Button, Card, Spin, Tooltip, Typography, theme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer } from 'reactflow';
import { getDaemonUrl } from '@/config/daemon';

interface ArtifactNodeData {
  objectId: string;
  artifactId: string;
  width: number;
  height: number;
  onUpdate: (id: string, data: BoardObject) => void;
  /** Lifecycle-safe delete: removes filesystem + board object + DB record */
  onDeleteArtifact?: (objectId: string, artifactId: string) => void;
}

const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;

/** Get auth headers for daemon REST calls (reads JWT from FeathersJS storage) */
function getAuthHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('feathers-jwt') : null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Inner component that captures Sandpack console events and forwards them to the daemon.
 * Must be inside SandpackProvider.
 */
function ConsoleReporter({ artifactId }: { artifactId: string }) {
  const { logs } = useSandpackConsole({ resetOnPreviewRestart: false });
  const lastSentRef = useRef(0);

  useEffect(() => {
    if (logs.length <= lastSentRef.current) return;

    const newLogs = logs.slice(lastSentRef.current);
    lastSentRef.current = logs.length;

    // Fire-and-forget POST to daemon
    const entries = newLogs.map((log) => ({
      timestamp: Date.now(),
      level:
        log.method === 'warn'
          ? 'warn'
          : log.method === 'error'
            ? 'error'
            : log.method === 'info'
              ? 'info'
              : 'log',
      message:
        log.data?.map((d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d))).join(' ') ??
        '',
    }));

    fetch(`${getDaemonUrl()}/artifacts/${artifactId}/console`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ entries }),
    }).catch(() => {
      // Silently ignore – console forwarding is best-effort
    });
  }, [logs, artifactId]);

  return null;
}

export const ArtifactNode = ({
  data,
  selected,
}: {
  data: ArtifactNodeData;
  selected?: boolean;
}) => {
  const { token } = theme.useToken();
  const [interactMode, setInteractMode] = useState(false);
  const [payload, setPayload] = useState<ArtifactPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastHashRef = useRef<string | null>(null);

  // Fetch artifact payload from daemon
  const fetchPayload = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`${getDaemonUrl()}/artifacts/${data.artifactId}/payload`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`Failed to load artifact: ${res.statusText}`);
      }
      const p: ArtifactPayload = await res.json();
      lastHashRef.current = p.content_hash;
      setPayload(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [data.artifactId]);

  // Initial fetch
  useEffect(() => {
    fetchPayload();
  }, [fetchPayload]);

  // Poll for hash changes (lightweight) — every 5s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${getDaemonUrl()}/artifacts/${data.artifactId}/hash`, {
          headers: getAuthHeaders(),
        });
        if (!res.ok) return;
        const { hash } = await res.json();
        if (hash && lastHashRef.current && hash !== lastHashRef.current) {
          fetchPayload();
        }
      } catch {
        // Ignore polling errors
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [data.artifactId, fetchPayload]);

  const handleResize = useCallback(
    (_event: unknown, params: { width: number; height: number }) => {
      const objectData: ArtifactBoardObject = {
        type: 'artifact',
        x: 0,
        y: 0,
        width: Math.max(params.width, MIN_WIDTH),
        height: Math.max(params.height, MIN_HEIGHT),
        artifact_id: data.artifactId as ArtifactID,
      };
      data.onUpdate(data.objectId, objectData);
    },
    [data]
  );

  // Loading state
  if (loading && !payload) {
    return (
      <Card
        style={{
          width: data.width,
          height: data.height,
          background: token.colorBgContainer,
          border: `2px solid ${token.colorBorder}`,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        styles={{
          body: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' },
        }}
      >
        <Spin indicator={<LoadingOutlined />} tip="Loading artifact..." />
      </Card>
    );
  }

  // Error state
  if (error) {
    return (
      <Card
        style={{
          width: data.width,
          height: data.height,
          background: token.colorBgContainer,
          border: `2px solid ${token.colorErrorBorder}`,
          borderRadius: 8,
        }}
        styles={{
          body: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 8,
          },
        }}
      >
        <CloseCircleOutlined style={{ fontSize: 24, color: token.colorError }} />
        <Typography.Text type="danger" style={{ fontSize: 12, textAlign: 'center' }}>
          {error}
        </Typography.Text>
        <Button size="small" icon={<ReloadOutlined />} onClick={fetchPayload}>
          Retry
        </Button>
      </Card>
    );
  }

  if (!payload) return null;

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        onResize={handleResize}
        lineStyle={{ borderColor: token.colorPrimary }}
        handleStyle={{ backgroundColor: token.colorPrimary, width: 8, height: 8 }}
      />
      <Card
        style={{
          width: data.width,
          height: data.height,
          background: token.colorBgContainer,
          border: `2px solid ${selected ? token.colorPrimary : token.colorBorder}`,
          borderRadius: 8,
          boxShadow: token.boxShadowSecondary,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        styles={{
          body: {
            padding: 0,
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        }}
        size="small"
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Badge
                status={loading ? 'processing' : 'success'}
                title={loading ? 'Reloading...' : 'Live'}
              />
              <Typography.Text
                style={{ fontSize: 12, fontWeight: 600, maxWidth: data.width - 160 }}
                ellipsis
              >
                {payload.name}
              </Typography.Text>
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              <Tooltip title="Reload">
                <Button
                  type="text"
                  size="small"
                  icon={<ReloadOutlined spin={loading} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    fetchPayload();
                  }}
                />
              </Tooltip>
              <Tooltip title={interactMode ? 'Exit interact mode' : 'Interact with app'}>
                <Button
                  type={interactMode ? 'primary' : 'text'}
                  size="small"
                  icon={interactMode ? <CheckCircleOutlined /> : <EyeOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    setInteractMode((prev) => !prev);
                  }}
                />
              </Tooltip>
              {data.onDeleteArtifact && (
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onDeleteArtifact?.(data.objectId, data.artifactId);
                  }}
                />
              )}
            </div>
          </div>
        }
      >
        {/* Force Sandpack internal containers to fill available height */}
        <style>{`
          .artifact-sandpack-wrapper .sp-wrapper,
          .artifact-sandpack-wrapper .sp-layout,
          .artifact-sandpack-wrapper .sp-stack,
          .artifact-sandpack-wrapper .sp-preview,
          .artifact-sandpack-wrapper .sp-preview-container {
            height: 100% !important;
          }
        `}</style>
        <div
          className="artifact-sandpack-wrapper"
          style={{
            flex: 1,
            position: 'relative',
          }}
        >
          {/* Transparent overlay blocks iframe from capturing mouse events (zoom/pan/drag)
              when not in interact mode. Iframes ignore pointer-events:none on ancestors. */}
          {!interactMode && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 1,
              }}
            />
          )}
          <SandpackProvider
            template={payload.template as 'react'}
            files={payload.files}
            customSetup={payload.dependencies ? { dependencies: payload.dependencies } : undefined}
            options={{
              initMode: 'user-visible',
              ...(payload.entry ? { activeFile: payload.entry } : {}),
            }}
          >
            <SandpackPreview
              style={{
                height: '100%',
                border: 'none',
              }}
              showNavigator={false}
              showOpenInCodeSandbox={false}
              showRefreshButton={interactMode}
            />
            <ConsoleReporter artifactId={data.artifactId} />
          </SandpackProvider>
        </div>
      </Card>
    </>
  );
};
