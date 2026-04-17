/**
 * ArtifactNode — Board canvas node for live Sandpack artifacts
 *
 * Fetches artifact payload from the daemon REST API, renders via Sandpack,
 * captures console events, and reloads when a WebSocket 'patched' event
 * signals a content_hash change.
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
} from '@agor-live/client';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  SandpackPreview,
  SandpackProvider,
  useSandpack,
  useSandpackConsole,
} from '@codesandbox/sandpack-react';
import { Badge, Button, Card, Spin, Tooltip, Typography, theme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer } from 'reactflow';
import { getDaemonUrl } from '@/config/daemon';
import { withBodyReset } from './utils/sandpackDefaults';

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
/** Max console entries to send per batch, and minimum interval between sends. */
const CONSOLE_BATCH_MAX = 50;
const CONSOLE_THROTTLE_MS = 2000;

function ConsoleReporter({ artifactId }: { artifactId: string }) {
  const { logs } = useSandpackConsole({ resetOnPreviewRestart: false });
  const lastSentRef = useRef(0);
  const lastSendTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (logs.length <= lastSentRef.current) return;

    const sendBatch = () => {
      const newLogs = logs.slice(lastSentRef.current, lastSentRef.current + CONSOLE_BATCH_MAX);
      lastSentRef.current = Math.min(logs.length, lastSentRef.current + CONSOLE_BATCH_MAX);
      lastSendTimeRef.current = Date.now();

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
          log.data
            ?.map((d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d)))
            .join(' ') ?? '',
      }));

      fetch(`${getDaemonUrl()}/artifacts/${artifactId}/console`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ entries }),
      }).catch(() => {});
    };

    const elapsed = Date.now() - lastSendTimeRef.current;
    if (elapsed >= CONSOLE_THROTTLE_MS) {
      sendBatch();
    } else if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        sendBatch();
      }, CONSOLE_THROTTLE_MS - elapsed);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [logs, artifactId]);

  return null;
}

/**
 * Inner component that captures Sandpack bundler/runtime errors and forwards them to the daemon.
 * These errors (e.g. "Could not find module './data'") happen inside Sandpack's bundler
 * before any user JS executes, so they never reach console.error.
 * Must be inside SandpackProvider.
 */
const SANDPACK_ERROR_THROTTLE_MS = 1000;

function SandpackErrorReporter({ artifactId }: { artifactId: string }) {
  const { sandpack } = useSandpack();
  const lastSentRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSendRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Serialize current state for comparison (includes status so status-only changes are sent)
    const stateKey = `${sandpack.error?.message ?? ''}\0${sandpack.status}`;

    // Skip if we already sent this exact state
    if (stateKey === lastSentRef.current) return;

    const sendError = () => {
      lastSentRef.current = stateKey;
      pendingSendRef.current = null;

      const payload: {
        error: {
          message: string;
          title?: string;
          path?: string;
          line?: number;
          column?: number;
        } | null;
        status: string;
      } = {
        error: sandpack.error
          ? {
              message: sandpack.error.message,
              ...(sandpack.error.title ? { title: sandpack.error.title } : {}),
              ...(sandpack.error.path ? { path: sandpack.error.path } : {}),
              ...(sandpack.error.line != null ? { line: sandpack.error.line } : {}),
              ...(sandpack.error.column != null ? { column: sandpack.error.column } : {}),
            }
          : null,
        status: sandpack.status,
      };

      fetch(`${getDaemonUrl()}/artifacts/${artifactId}/sandpack-error`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      }).catch(() => {});
    };

    // Throttle to avoid spamming during rapid state changes
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    pendingSendRef.current = sendError;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      sendError();
    }, SANDPACK_ERROR_THROTTLE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        // Flush pending update on unmount to avoid stale backend state
        pendingSendRef.current?.();
      }
    };
  }, [sandpack.error, sandpack.status, artifactId]);

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

  // Re-fetch payload when the artifact is updated (via WebSocket 'patched' event)
  useEffect(() => {
    const handler = (e: Event) => {
      const { artifactId, contentHash } = (e as CustomEvent).detail;
      if (artifactId === data.artifactId && contentHash !== lastHashRef.current) {
        fetchPayload();
      }
    };
    window.addEventListener('agor:artifact-patched', handler);
    return () => window.removeEventListener('agor:artifact-patched', handler);
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
            key={payload.content_hash}
            template={payload.template as 'react'}
            files={withBodyReset(payload.files)}
            customSetup={payload.dependencies ? { dependencies: payload.dependencies } : undefined}
            options={{
              initMode: 'user-visible',
              ...(payload.entry ? { activeFile: payload.entry } : {}),
              ...(payload.bundlerURL ? { bundlerURL: payload.bundlerURL } : {}),
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
              // When self-hosting the bundler at a subpath (e.g. /static/sandpack/),
              // Sandpack's default startRoute "/" resolves via `new URL("/", bundlerURL)`
              // to the origin root per the WHATWG URL spec, wiping out the subpath and
              // loading the wrong page into the iframe. Use "./" so it resolves to the
              // bundler's own directory. NOTE: this MUST be passed as a prop directly
              // on SandpackPreview — setting it via SandpackProvider.options is silently
              // overridden because SandpackPreview's own prop default ("/") is always
              // forwarded as clientPropsOverride, which wins over options.startRoute.
              {...(payload.bundlerURL ? { startRoute: './' } : {})}
            />
            <ConsoleReporter artifactId={data.artifactId} />
            <SandpackErrorReporter artifactId={data.artifactId} />
          </SandpackProvider>
        </div>
      </Card>
    </>
  );
};
