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
  ExportOutlined,
  EyeOutlined,
  LoadingOutlined,
  LockOutlined,
  ReloadOutlined,
  SafetyOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  SandpackPreview,
  SandpackProvider,
  type SandpackSetup,
  useSandpack,
  useSandpackConsole,
} from '@codesandbox/sandpack-react';
import { Alert, Badge, Button, Card, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import { compressToBase64 } from 'lz-string';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer } from 'reactflow';
import { getDaemonUrl } from '@/config/daemon';
import { useThemedMessage } from '@/utils/message';
import { ArtifactConsentModal } from '../../ArtifactConsentModal/ArtifactConsentModal';
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

/** Forgiving JSON parse — used when reading a user's package.json which may
 *  be malformed; we'd rather export with a synthesized package.json than
 *  fail the whole flow. */
function safeJsonParse(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const ArtifactNode = ({
  data,
  selected,
}: {
  data: ArtifactNodeData;
  selected?: boolean;
}) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const [interactMode, setInteractMode] = useState(false);
  const [payload, setPayload] = useState<ArtifactPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
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

  // Eject the artifact to a fresh CodeSandbox sandbox in a new tab.
  // (helper used inside the handler to forgive parse errors on user pkg.json)
  //
  // Browser-side form-POST instead of a daemon round-trip — the daemon's
  // outbound IP is consistently blocked by Cloudflare on CodeSandbox's
  // define endpoint, but real browser submissions go through. This is also
  // what AntD/Storybook do for their "Open in CodeSandbox" buttons.
  //
  // Implementation matches @codesandbox/sandpack-client's `getParameters`:
  // LZString.compressToBase64 with URL-safe character substitution.
  const handleOpenInCodeSandbox = useCallback(() => {
    if (!payload) return;
    const filesPayload: Record<string, { content: string }> = {};
    let userPackageJson: string | null = null;
    for (const [filePath, content] of Object.entries(payload.files)) {
      const stripped = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      // Strip Agor-only sidecars + the synthesized .env — they'd be inert
      // (or broken) outside Agor. The synthesized .env carries the viewer's
      // secrets; never ship it to a third party.
      if (
        stripped === 'agor.config.js' ||
        stripped === 'agor.artifact.json' ||
        stripped === '.env'
      ) {
        continue;
      }
      // Hold onto the user's package.json (if any) — we merge it below to
      // make sure CSB sees the artifact's dependencies even when the
      // author kept them in `sandpack_config.customSetup` rather than the
      // package.json itself.
      if (stripped === 'package.json') {
        userPackageJson = content;
        continue;
      }
      filesPayload[stripped] = { content };
    }

    // Merge dependencies: user's package.json > artifact.dependencies cache
    // > sandpack_config.customSetup.dependencies. CSB infers the runtime
    // (CRA / vue-cli / svelte / parcel / …) from the dependency graph in
    // `package.json`, so getting this right is what makes the export work.
    const userPkg: Record<string, unknown> =
      (userPackageJson ? safeJsonParse(userPackageJson) : null) ?? {};
    const customSetupDeps = payload.sandpack_config?.customSetup?.dependencies ?? {};
    const cachedDeps = payload.dependencies ?? {};
    const mergedDeps: Record<string, string> = {
      ...customSetupDeps,
      ...cachedDeps,
      ...((userPkg.dependencies as Record<string, string> | undefined) ?? {}),
    };
    const finalPkg: Record<string, unknown> = {
      name: 'artifact-export',
      version: '0.0.0',
      main: payload.entry ?? userPkg.main ?? 'src/index.js',
      ...userPkg,
      dependencies: mergedDeps,
    };
    filesPayload['package.json'] = { content: JSON.stringify(finalPkg, null, 2) };

    // Don't send a top-level `template` — Sandpack template names (`react`,
    // `react-ts`, `vue3`, …) are NOT valid CSB template names (`create-
    // react-app`, `vue-cli`, …). Letting CSB infer from package.json deps
    // is both simpler and more reliable than maintaining a translation
    // table.
    const definePayload = { files: filesPayload };
    const parameters = compressToBase64(JSON.stringify(definePayload))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = 'https://codesandbox.io/api/v1/sandboxes/define';
    form.target = '_blank';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'parameters';
    input.value = parameters;
    form.appendChild(input);
    document.body.appendChild(form);
    try {
      form.submit();
    } catch (err) {
      showError(`Open in CodeSandbox failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      form.remove();
    }
  }, [payload, showError]);

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
        <Spin indicator={<LoadingOutlined />} description="Loading artifact..." />
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

  const sandpackConfig = payload.sandpack_config ?? {};
  const sandpackOptions = sandpackConfig.options ?? {};
  const customSetup = {
    ...(sandpackConfig.customSetup ?? {}),
    ...(payload.dependencies && !sandpackConfig.customSetup?.dependencies
      ? { dependencies: payload.dependencies }
      : {}),
  };
  const sandpackTemplate = (sandpackConfig.template ?? payload.template) as 'react';
  const trustBadge = renderTrustBadge(payload);
  const showConsentAffordance =
    payload.trust_state === 'untrusted' &&
    ((payload.required_env_vars && payload.required_env_vars.length > 0) ||
      (payload.agor_grants && Object.keys(payload.agor_grants).length > 0));
  const legacyBanner = payload.legacy?.is_legacy
    ? renderLegacyBanner(payload.legacy.upgrade_instructions, token)
    : null;

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <Badge
                status={loading ? 'processing' : 'success'}
                title={loading ? 'Reloading...' : 'Live'}
              />
              <Typography.Text
                style={{ fontSize: 12, fontWeight: 600, maxWidth: data.width - 200 }}
                ellipsis
              >
                {payload.name}
              </Typography.Text>
              {trustBadge}
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {showConsentAffordance && (
                <Tooltip title="Trust this artifact to inject secrets">
                  <Button
                    type="text"
                    size="small"
                    // `danger` themes the icon via Ant's colorError token —
                    // signals "this artifact won't render with secrets until
                    // you grant trust" without us hardcoding a hex.
                    danger
                    icon={<LockOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConsentOpen(true);
                    }}
                  />
                </Tooltip>
              )}
              <Tooltip title="Open in CodeSandbox (eject — daemon-injected env vars/AGOR_TOKEN won't carry over)">
                <Button
                  type="text"
                  size="small"
                  icon={<ExportOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenInCodeSandbox();
                  }}
                />
              </Tooltip>
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
          // React Flow's node-drag, canvas-pan, and wheel-zoom listeners all
          // attach at the node level and would otherwise fire on every
          // mousedown/wheel inside the iframe. The `nodrag nopan nowheel`
          // classes are React Flow's documented escape hatch — without them,
          // dragging to text-select inside the artifact starts a node drag
          // (so copy/paste / selection breaks), and scrolling a long page
          // zooms the canvas. Only apply in interact mode so the card
          // remains draggable when the iframe is overlay-blocked.
          className={`artifact-sandpack-wrapper${interactMode ? ' nodrag nopan nowheel' : ''}`}
          style={{
            flex: 1,
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {legacyBanner}
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
            template={sandpackTemplate}
            files={withBodyReset(payload.files)}
            customSetup={
              Object.keys(customSetup).length > 0 ? (customSetup as SandpackSetup) : undefined
            }
            theme={sandpackConfig.theme as never}
            options={{
              initMode: 'user-visible',
              ...sandpackOptions,
              ...(payload.entry && !sandpackOptions.activeFile
                ? { activeFile: payload.entry }
                : {}),
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
            <SandpackErrorReporter artifactId={data.artifactId} />
          </SandpackProvider>
        </div>
      </Card>
      {consentOpen && (
        <ArtifactConsentModal
          open={consentOpen}
          artifactId={payload.artifact_id}
          name={payload.name}
          files={payload.files}
          requiredEnvVars={payload.required_env_vars ?? []}
          grants={payload.agor_grants ?? {}}
          onClose={() => setConsentOpen(false)}
          onGranted={() => {
            setConsentOpen(false);
            fetchPayload();
          }}
        />
      )}
    </>
  );
};

function renderTrustBadge(payload: ArtifactPayload) {
  const state = payload.trust_state;
  if (state === 'no_secrets_needed') return null;
  if (state === 'self') {
    return (
      <Tag color="blue" icon={<SafetyOutlined />} style={{ fontSize: 10, marginLeft: 4 }}>
        Yours
      </Tag>
    );
  }
  if (state === 'trusted') {
    const scopeLabel =
      payload.trust_scope === 'instance'
        ? 'instance-wide'
        : payload.trust_scope === 'author'
          ? 'this author'
          : payload.trust_scope === 'session'
            ? 'just-once'
            : 'this artifact';
    return (
      <Tooltip title={`Secrets injected — trust granted for ${scopeLabel}`}>
        <Tag color="green" icon={<SafetyOutlined />} style={{ fontSize: 10, marginLeft: 4 }}>
          Trusted
        </Tag>
      </Tooltip>
    );
  }
  // 'untrusted'
  return (
    <Tooltip title="Render is missing secrets — click the lock icon to grant trust">
      <Tag color="orange" icon={<LockOutlined />} style={{ fontSize: 10, marginLeft: 4 }}>
        Untrusted
      </Tag>
    </Tooltip>
  );
}

function renderLegacyBanner(
  upgradeInstructions: string,
  token: ReturnType<typeof theme.useToken>['token']
) {
  return (
    <Alert
      type="warning"
      showIcon
      icon={<WarningOutlined />}
      // `nodrag nopan` so clicking on the banner doesn't start a React
      // Flow node drag — without these, the user can't select the upgrade
      // prompt text to copy it.
      className="nodrag nopan"
      style={{ borderRadius: 0, fontSize: 11, padding: '4px 12px' }}
      message="Legacy artifact — won't render correctly"
      description={
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', color: token.colorTextSecondary }}>
            Show upgrade prompt for an agent
          </summary>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 10,
              marginTop: 6,
              padding: 8,
              background: token.colorFillTertiary,
              borderRadius: 4,
              maxHeight: 180,
              overflow: 'auto',
              // React Flow nodes default to `user-select: none` to keep
              // drag clean — opt this <pre> back into text selection so
              // users can copy the upgrade prompt.
              userSelect: 'text',
              cursor: 'text',
            }}
          >
            {upgradeInstructions}
          </pre>
        </details>
      }
    />
  );
}
