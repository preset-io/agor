import type {
  ArtifactBoardObject,
  ArtifactID,
  ArtifactPayload,
  BoardObject,
} from '@agor-live/client';
import { artifactFullscreenPath, shortId } from '@agor-live/client';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  ExportOutlined,
  EyeOutlined,
  FullscreenOutlined,
  LoadingOutlined,
  LockOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  SandpackPreview,
  SandpackProvider,
  type SandpackSetup,
  useSandpack,
} from '@codesandbox/sandpack-react';
import { Alert, Badge, Button, Card, Popconfirm, Spin, Tooltip, Typography, theme } from 'antd';
import { compressToBase64 } from 'lz-string';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer } from 'reactflow';
import {
  ArtifactConsoleReporter,
  ArtifactRuntimeBridge,
  ArtifactSandpackErrorReporter,
  renderArtifactTrustBadge,
} from '@/components/artifacts/ArtifactRenderSupport';
import { getDaemonUrl } from '@/config/daemon';
import { getAuthHeaders } from '@/utils/authHeaders';
import { copyToClipboard } from '@/utils/clipboard';
import { useThemedMessage } from '@/utils/message';
import { ensureSandpackCryptoSubtle } from '@/utils/sandpackCrypto';
import { uiRouteHref } from '@/utils/uiRoutes';
import { ArtifactConsentModal } from '../../ArtifactConsentModal/ArtifactConsentModal';
import { withBodyReset } from './utils/sandpackDefaults';

ensureSandpackCryptoSubtle();

interface ArtifactNodeData {
  objectId: string;
  artifactId: string;
  width: number;
  height: number;
  /** True when this artifact is the deep-link target of the current URL
   *  (`/a/<artifactShort>/`). Renders the same dashed "selected"
   *  outline used on BranchCard, layered on top of React Flow's
   *  primary-color `selected` border so click-selection and URL-target
   *  stay independently legible. */
  isActiveUrlTarget?: boolean;
  onUpdate: (id: string, data: BoardObject) => void;
  /** Lifecycle-safe delete: removes filesystem + board object + DB record */
  onDeleteArtifact?: (objectId: string, artifactId: string) => void;
}

const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;

/**
 * Eject the rendered artifact to a fresh CodeSandbox sandbox in a new tab.
 *
 * Sits inside `<SandpackProvider>` so it can read `useSandpack().sandpack` —
 * specifically `sandpack.files` (the *resolved* bundler file map, which
 * includes the template scaffolding files Sandpack synthesizes) and
 * `sandpack.environment` (the CSB-compatible runtime name like
 * `create-react-app` / `parcel` / `vue-cli`). Building the payload from
 * the daemon's raw `payload.files` skipped both — without scaffolding,
 * CSB has no entry point to render and no DOM root to mount on, so the
 * resulting sandbox boots empty.
 *
 * Triggered by a window event the outer header button dispatches; we
 * can't move the button itself inside the provider because it lives in
 * the React-Flow node header (outside the Sandpack subtree).
 *
 * Browser-side form-POST instead of a daemon round-trip — the daemon's
 * outbound IP is consistently blocked by Cloudflare on CodeSandbox's
 * define endpoint, but real browser submissions go through.
 */
const STRIPPED_FROM_EXPORT = new Set([
  // Agor-only sidecars — inert/broken outside Agor.
  'agor.config.js',
  'agor.artifact.json',
  // The synthesized .env carries the *viewer's* secrets — never ship to a
  // third party even though Sandpack happens to have it in the file map.
  '.env',
]);
function CodeSandboxExporter({ artifactId }: { artifactId: string }) {
  const { sandpack } = useSandpack();
  const { showError } = useThemedMessage();
  // Park the sandpack state in a ref so the window-event handler reads
  // the latest resolved file map without re-attaching on every tick.
  const sandpackRef = useRef(sandpack);
  sandpackRef.current = sandpack;

  useEffect(() => {
    const handler = () => {
      const current = sandpackRef.current;
      const normalizedFiles: Record<string, { content: string; isBinary: boolean }> = {};
      for (const [filePath, file] of Object.entries(current.files)) {
        const stripped = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        if (STRIPPED_FROM_EXPORT.has(stripped)) continue;
        normalizedFiles[stripped] = { content: file.code, isBinary: false };
      }
      // Mirror Sandpack's `getFileParameters`: include `template:
      // environment` inside the compressed parameters so CSB picks the
      // right runtime (without it, the sandbox renders nothing).
      const definePayload: Record<string, unknown> = { files: normalizedFiles };
      if (current.environment) definePayload.template = current.environment;
      const parameters = compressToBase64(JSON.stringify(definePayload))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const form = document.createElement('form');
      form.method = 'POST';
      form.action = 'https://codesandbox.io/api/v1/sandboxes/define';
      form.target = '_blank';
      const paramsInput = document.createElement('input');
      paramsInput.type = 'hidden';
      paramsInput.name = 'parameters';
      paramsInput.value = parameters;
      form.appendChild(paramsInput);
      // Sandpack sends `environment` as a separate top-level input too,
      // not just inside `parameters` — keep parity to be safe.
      if (current.environment) {
        const envInput = document.createElement('input');
        envInput.type = 'hidden';
        envInput.name = 'environment';
        envInput.value = current.environment;
        form.appendChild(envInput);
      }
      document.body.appendChild(form);
      try {
        form.submit();
      } catch (err) {
        showError(
          `Open in CodeSandbox failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        form.remove();
      }
    };
    const eventName = `agor:export-codesandbox-${artifactId}`;
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [artifactId, showError]);

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

  // The actual form-POST work happens inside <CodeSandboxExporter/>, which
  // lives inside SandpackProvider so it can use `useSandpack()` to read the
  // *resolved* file map and runtime environment. Trying to build the
  // payload from `payload.files` outside the provider misses the template
  // scaffolding files (`index.html`, `index.js`, `package.json`, etc.) that
  // Sandpack synthesizes per template — without those the destination
  // sandbox boots empty (no entry, no DOM root).
  const handleOpenInCodeSandbox = useCallback(() => {
    window.dispatchEvent(new CustomEvent(`agor:export-codesandbox-${data.artifactId}`));
  }, [data.artifactId]);

  const handleOpenFullscreen = useCallback(() => {
    window.open(
      uiRouteHref(artifactFullscreenPath(data.artifactId as ArtifactID)),
      '_blank',
      'noopener,noreferrer'
    );
  }, [data.artifactId]);

  // Title bar — always rendered, regardless of load state. When the
  // payload hasn't come back yet (initial fetch in flight, or the row's
  // files column got corrupted and getPayload threw), the user still
  // needs to see which card is which on the board so they can hit the
  // reload or delete button. We fall back to a short-id placeholder
  // until `payload.name` is available.
  //
  // The action buttons split into two groups: the ones that need a
  // valid payload to do anything useful (export, interact, consent)
  // only render when `payload` exists; reload and delete are always
  // available so a stuck artifact can be retried or removed.
  const fallbackName = `Artifact ${shortId(data.artifactId)}`;
  const headerBadgeStatus: 'processing' | 'error' | 'success' = error
    ? 'error'
    : loading
      ? 'processing'
      : 'success';
  const headerBadgeTitle = error ? 'Failed to load' : loading ? 'Reloading...' : 'Live';
  const trustBadge = payload
    ? renderArtifactTrustBadge(payload, () => setConsentOpen(true), { className: 'nodrag nopan' })
    : null;
  // A loaded payload that's also in the error state is stale — the body
  // renders the error placeholder, so the header shouldn't expose
  // payload-acting controls (Export / Interact / Consent) that operate
  // on the stale data. Keep the title + Reload + Delete though, since
  // those still help the user act on the broken state.
  const hasUsablePayload = !!payload && !error;
  const hasRequiredEnvVars = (payload?.required_env_vars?.length ?? 0) > 0;
  const hasConsentGrants = Object.keys(payload?.agor_grants ?? {}).length > 0;
  const showConsentAffordance =
    hasUsablePayload &&
    payload?.trust_state === 'untrusted' &&
    (hasRequiredEnvVars || hasConsentGrants);

  const cardTitle = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <Badge status={headerBadgeStatus} title={headerBadgeTitle} />
        <Typography.Text
          style={{ fontSize: 12, fontWeight: 600, maxWidth: data.width - 200 }}
          ellipsis
        >
          {payload?.name ?? fallbackName}
        </Typography.Text>
        {trustBadge}
      </div>
      {/* `nodrag nopan` — React Flow's escape hatch. Without it the canvas
          interprets a mousedown on these controls as the start of a node
          drag (stopPropagation on click is too late, by then the drag
          handler has already armed). Same pattern used elsewhere in this
          file for the interact-mode iframe wrapper. */}
      <div className="nodrag nopan" style={{ display: 'flex', gap: 2 }}>
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
        <Tooltip title="Open fullscreen">
          <Button
            type="text"
            size="small"
            icon={<FullscreenOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              handleOpenFullscreen();
            }}
          />
        </Tooltip>
        {hasUsablePayload && (
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
        )}
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
        {hasUsablePayload && (
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
        )}
        {data.onDeleteArtifact && (
          <Popconfirm
            title="Delete artifact?"
            description={`This will delete "${payload?.name ?? fallbackName}" and its files.`}
            onConfirm={(e) => {
              e?.stopPropagation();
              data.onDeleteArtifact?.(data.objectId, data.artifactId);
            }}
            onCancel={(e) => e?.stopPropagation()}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Tooltip title="Delete artifact">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={(e) => e.stopPropagation()}
              />
            </Tooltip>
          </Popconfirm>
        )}
      </div>
    </div>
  );

  // Shared Card chrome — body content swaps based on load state but the
  // title bar stays put so the user always knows which artifact this is.
  // Border still reflects error / React-Flow-selected state. The
  // active-URL-target signal rides on `outline` (dashed, in
  // `colorTextBase`) — same neutral selection language used on
  // BranchCard so users learn one visual vocabulary for "this is what
  // you navigated to."
  const borderColor = error
    ? token.colorErrorBorder
    : selected
      ? token.colorPrimary
      : token.colorBorder;
  const cardOuterStyle = {
    width: data.width,
    height: data.height,
    background: token.colorBgContainer,
    border: `2px solid ${borderColor}`,
    borderRadius: 8,
    boxShadow: token.boxShadowSecondary,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    ...(data.isActiveUrlTarget
      ? {
          outline: `2px dashed ${token.colorTextBase}`,
          outlineOffset: -3,
        }
      : {}),
  } as const;

  // Shared resizer — same across loading / error / normal states.
  const resizer = (
    <NodeResizer
      isVisible={selected}
      minWidth={MIN_WIDTH}
      minHeight={MIN_HEIGHT}
      onResize={handleResize}
      lineStyle={{ borderColor: token.colorPrimary }}
      handleStyle={{ backgroundColor: token.colorPrimary, width: 8, height: 8 }}
    />
  );

  // Loading state — title bar is still visible (with reload + delete) so
  // a stuck loader can be retried or pruned.
  if (loading && !payload) {
    return (
      <>
        {resizer}
        <Card
          style={cardOuterStyle}
          styles={{
            body: {
              padding: 0,
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
          }}
          size="small"
          title={cardTitle}
        >
          <Spin indicator={<LoadingOutlined />} description="Loading artifact..." />
        </Card>
      </>
    );
  }

  // Error state — title bar visible so the user can see which artifact
  // failed and act on it (Retry / Delete) without guessing.
  if (error) {
    return (
      <>
        {resizer}
        <Card
          style={cardOuterStyle}
          styles={{
            body: {
              padding: 0,
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            },
          }}
          size="small"
          title={cardTitle}
        >
          <CloseCircleOutlined style={{ fontSize: 24, color: token.colorError }} />
          <Typography.Text
            type="danger"
            style={{ fontSize: 12, textAlign: 'center', padding: '0 16px' }}
          >
            {error}
          </Typography.Text>
          <Button
            className="nodrag nopan"
            size="small"
            icon={<ReloadOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              fetchPayload();
            }}
          >
            Retry
          </Button>
        </Card>
      </>
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
  const legacyBanner = payload.legacy?.is_legacy ? (
    <LegacyBanner upgradeInstructions={payload.legacy.upgrade_instructions} />
  ) : null;

  return (
    <>
      {resizer}
      <Card
        style={cardOuterStyle}
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
        title={cardTitle}
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
            <ArtifactConsoleReporter artifactId={data.artifactId} />
            <ArtifactSandpackErrorReporter artifactId={data.artifactId} />
            <ArtifactRuntimeBridge artifactId={data.artifactId} />
            <CodeSandboxExporter artifactId={data.artifactId} />
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

function LegacyBanner({ upgradeInstructions }: { upgradeInstructions: string }) {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const handleCopy = async () => {
    const ok = await copyToClipboard(upgradeInstructions);
    if (ok) showSuccess('Upgrade prompt copied — paste it to an agent');
    else showError('Failed to copy — select the text manually and copy with the keyboard');
  };
  return (
    <Alert
      type="warning"
      showIcon
      icon={<WarningOutlined />}
      // `nodrag nopan` so clicking on the banner doesn't start a React
      // Flow node drag — without these, the user can't select the upgrade
      // prompt text to copy it.
      className="nodrag nopan"
      style={{ borderRadius: 0, fontSize: 11, padding: '10px 14px' }}
      title="Legacy artifact — won't render correctly"
      description={
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', color: token.colorTextSecondary }}>
            Show upgrade prompt for an agent
          </summary>
          <div style={{ position: 'relative', marginTop: 6 }}>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={handleCopy}
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                zIndex: 1,
                fontSize: 11,
              }}
            >
              Copy
            </Button>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: 10,
                margin: 0,
                padding: 8,
                paddingRight: 64, // leave room for the absolute-positioned copy button
                background: token.colorFillTertiary,
                borderRadius: 4,
                maxHeight: 180,
                overflow: 'auto',
                // React Flow nodes default to `user-select: none` to keep
                // drag clean — opt this <pre> back into text selection so
                // users can copy the upgrade prompt manually too.
                userSelect: 'text',
                cursor: 'text',
              }}
            >
              {upgradeInstructions}
            </pre>
          </div>
        </details>
      }
    />
  );
}
