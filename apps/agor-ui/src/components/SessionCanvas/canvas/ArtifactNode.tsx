import type {
  ArtifactBoardObject,
  ArtifactID,
  ArtifactPayload,
  BoardObject,
  SandpackTemplate,
  SessionID,
} from '@agor-live/client';
import { artifactFullscreenPath, sessionPath, shortId } from '@agor-live/client';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  ExportOutlined,
  EyeOutlined,
  FullscreenOutlined,
  LoadingOutlined,
  LockOutlined,
  MessageOutlined,
  ReloadOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import {
  type SandpackPredefinedTemplate,
  SandpackPreview,
  SandpackProvider,
  type SandpackSetup,
  useSandpack,
} from '@codesandbox/sandpack-react';
import { Badge, Button, Card, Popconfirm, Spin, Tooltip, Typography, theme } from 'antd';
import { compressToBase64 } from 'lz-string';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer } from 'reactflow';
import {
  ArtifactConsoleReporter,
  ArtifactRuntimeBridge,
  ArtifactSandpackErrorReporter,
  ArtifactTrustStatusIcon,
} from '@/components/artifacts/ArtifactRenderSupport';
import { useThemedMessage } from '@/utils/message';
import { ensureSandpackCryptoSubtle } from '@/utils/sandpackCrypto';
import { uiRouteHref } from '@/utils/uiRoutes';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import type { BoardWriteTicket } from '../../../store/boardMutationGuard';
import { ArtifactConsentModal } from '../../ArtifactConsentModal/ArtifactConsentModal';
import { ArtifactLegacyNotice, ArtifactLoadErrorNotice } from './ArtifactNotices';
import { type ArtifactLoadFailure, fetchArtifactPayload } from './artifactLoadError';
import { useStableSandpackProviderInputs } from './utils/sandpackDefaults';

ensureSandpackCryptoSubtle();

export interface ArtifactNodeData {
  objectId: string;
  artifactId: string;
  width: number;
  height: number;
  canEdit: boolean;
  /** True when this artifact is the deep-link target of the current URL
   *  (`/a/<artifactShort>/`). Renders the same dashed "selected"
   *  outline used on BranchCard, layered on top of React Flow's
   *  primary-color `selected` border so click-selection and URL-target
   *  stay independently legible. */
  isActiveUrlTarget?: boolean;
  onUpdate: (id: string, data: BoardObject) => void;
  locked?: boolean;
  x: number;
  y: number;
  /** Lifecycle-safe delete: removes filesystem + board object + DB record */
  /** `ticket`: captured when the confirmation opened (`null` is refused). */
  onDeleteArtifact?: (
    objectId: string,
    artifactId: string,
    ticket: BoardWriteTicket | null
  ) => void;
  /** Capture the write ticket when the delete confirmation opens. */
  beginArtifactDelete?: () => BoardWriteTicket | null;
}

const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;
const EMPTY_SANDPACK_FILES: Record<string, string> = {};

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
          `Couldn't open in CodeSandbox. (${err instanceof Error ? err.message : String(err)})`
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
  const mutationGate = useMutationGate();
  const layoutMutationDisabled = !mutationGate.canMutate || !data.canEdit;
  const [interactMode, setInteractMode] = useState(false);
  const [payload, setPayload] = useState<ArtifactPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ArtifactLoadFailure | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Captured when the delete confirmation opens: a board reload drops it.
  const [deleteTicket, setDeleteTicket] = useState<BoardWriteTicket | null>(null);
  const lastHashRef = useRef<string | null>(null);
  const sandpackConfig = payload?.sandpack_config;
  const sandpackOptions = sandpackConfig?.options;
  const sandpackTemplate = (sandpackConfig?.template ??
    payload?.template ??
    'react') as SandpackTemplate;
  const sandpackInputs = useStableSandpackProviderInputs({
    template: sandpackTemplate,
    files: payload?.files ?? EMPTY_SANDPACK_FILES,
    customSetup: sandpackConfig?.customSetup,
    dependencies: payload?.dependencies,
    entryFile: payload?.entry,
    options: sandpackOptions,
  });

  // Fetch artifact payload from daemon
  const fetchPayload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await fetchArtifactPayload(data.artifactId);
    if (result.failure) {
      setError(result.failure);
    } else {
      lastHashRef.current = result.payload.content_hash;
      setPayload(result.payload);
    }
    setLoading(false);
  }, [data.artifactId]);

  // Initial fetch
  useEffect(() => {
    fetchPayload();
  }, [fetchPayload]);

  useEffect(() => {
    if (!mutationGate.canMutate) setDeleteConfirmOpen(false);
  }, [mutationGate.canMutate]);

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
    (_event: unknown, params: { x: number; y: number; width: number; height: number }) => {
      if (layoutMutationDisabled) return;
      const objectData: ArtifactBoardObject = {
        type: 'artifact',
        x: params.x,
        y: params.y,
        width: Math.max(params.width, MIN_WIDTH),
        height: Math.max(params.height, MIN_HEIGHT),
        artifact_id: data.artifactId as ArtifactID,
        locked: data.locked,
      };
      data.onUpdate(data.objectId, objectData);
    },
    [data, layoutMutationDisabled]
  );

  // The actual form-POST work happens inside <CodeSandboxExporter/>, which
  // lives inside SandpackProvider so it can use `useSandpack()` to read the
  // *resolved* file map and runtime environment. Trying to build the
  // payload from `payload.files` outside the provider misses the template
  // scaffolding files (`index.html`, `index.js`, `package.json`, etc.) that
  // Sandpack synthesizes per template — without those the destination
  // sandbox boots empty (no entry, no DOM root).

  const handleToggleLock = useCallback(() => {
    if (layoutMutationDisabled) return;
    const objectData: ArtifactBoardObject = {
      type: 'artifact',
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height,
      artifact_id: data.artifactId as ArtifactID,
      locked: !data.locked,
    };
    data.onUpdate(data.objectId, objectData);
  }, [data, layoutMutationDisabled]);

  const handleOpenInCodeSandbox = useCallback(() => {
    window.dispatchEvent(new CustomEvent(`agor:export-codesandbox-${data.artifactId}`));
  }, [data.artifactId]);

  const handleOpenCreatingSession = useCallback(() => {
    if (!payload?.source_session_id) return;
    window.open(
      uiRouteHref(sessionPath(payload.source_session_id as SessionID)),
      '_blank',
      'noopener,noreferrer'
    );
  }, [payload?.source_session_id]);

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
  const headerBadgeTitle = error ? "Couldn't load" : loading ? 'Reloading…' : 'Live';
  // A loaded payload that's also in the error state is stale — the body
  // renders the error placeholder, so the header shouldn't expose
  // payload-acting controls (Export / Interact / Consent) that operate
  // on the stale data. Keep the title + Reload + Delete though, since
  // those still help the user act on the broken state.
  const hasUsablePayload = !!payload && !error;
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
        {hasUsablePayload && (
          <ArtifactTrustStatusIcon
            payload={payload}
            onTrustClick={() => setConsentOpen(true)}
            className="nodrag nopan"
          />
        )}
      </div>
      {/* `nodrag nopan` — React Flow's escape hatch. Without it the canvas
          interprets a mousedown on these controls as the start of a node
          drag (stopPropagation on click is too late, by then the drag
          handler has already armed). Same pattern used elsewhere in this
          file for the interact-mode iframe wrapper. */}
      <div className="nodrag nopan" style={{ display: 'flex', gap: 2 }}>
        <Tooltip title={data.locked ? 'Unlock artifact card' : 'Lock artifact card'}>
          <Button
            type="text"
            size="small"
            aria-label={data.locked ? 'Unlock artifact card' : 'Lock artifact card'}
            icon={data.locked ? <LockOutlined /> : <UnlockOutlined />}
            disabled={layoutMutationDisabled}
            onClick={(e) => {
              e.stopPropagation();
              handleToggleLock();
            }}
            style={{
              backgroundColor: data.locked ? token.colorWarningBg : undefined,
              color: data.locked ? token.colorWarning : undefined,
            }}
          />
        </Tooltip>
        {payload?.source_session_id && (
          <Tooltip title="Open session that created this artifact">
            <Button
              type="text"
              size="small"
              icon={<MessageOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                handleOpenCreatingSession();
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
          <Tooltip title="Open in CodeSandbox. Features Agor adds to this artifact won't carry over.">
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
            open={deleteConfirmOpen}
            destroyOnHidden
            onOpenChange={(open) => {
              if (open && mutationGate.canMutate)
                setDeleteTicket(data.beginArtifactDelete?.() ?? null);
              if (!open || mutationGate.canMutate) setDeleteConfirmOpen(open);
            }}
            title="Delete artifact?"
            description={`This will delete "${payload?.name ?? fallbackName}" and its files.`}
            onConfirm={(e) => {
              e?.stopPropagation();
              if (!mutationGate.canMutate) return;
              data.onDeleteArtifact?.(data.objectId, data.artifactId, deleteTicket);
            }}
            onCancel={(e) => e?.stopPropagation()}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true, disabled: !mutationGate.canMutate }}
            disabled={!mutationGate.canMutate}
          >
            <Tooltip title="Delete artifact">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label="Delete artifact"
                disabled={!mutationGate.canMutate}
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
      isVisible={selected && !data.locked && !layoutMutationDisabled}
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
          <Spin indicator={<LoadingOutlined />} description="Loading artifact…" />
        </Card>
      </>
    );
  }

  // Error state — title bar visible so the user can see which artifact
  // failed and act on it (Try again / Delete) without guessing.
  if (error) {
    return (
      <>
        {resizer}
        <Card
          style={cardOuterStyle}
          styles={{
            body: {
              padding: 8,
              flex: 1,
              overflow: 'auto',
            },
          }}
          size="small"
          title={cardTitle}
        >
          <ArtifactLoadErrorNotice
            failure={error}
            onRetry={fetchPayload}
            className="nodrag nopan nowheel"
            style={{ userSelect: 'text' }}
          />
        </Card>
      </>
    );
  }

  if (!payload) return null;

  // `nodrag nopan nowheel` + `userSelect` so the upgrade prompt can be
  // selected and scrolled without dragging or zooming the canvas.
  const legacyBanner = payload.legacy?.is_legacy ? (
    <ArtifactLegacyNotice
      upgradeInstructions={payload.legacy.upgrade_instructions}
      className="nodrag nopan nowheel"
      style={{
        borderRadius: 0,
        flexShrink: 0,
        maxHeight: '50%',
        overflowY: 'auto',
        userSelect: 'text',
      }}
    />
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
            // The shared artifact union includes legacy `vue3`; Sandpack's
            // provider type is narrower than the persisted compatibility set.
            template={sandpackInputs.template as SandpackPredefinedTemplate}
            files={sandpackInputs.files}
            customSetup={sandpackInputs.customSetup as SandpackSetup | undefined}
            theme={sandpackConfig?.theme as never}
            options={sandpackInputs.options}
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
            <ArtifactConsoleReporter
              artifactId={data.artifactId}
              contentHash={payload.runtime_report_hash ?? payload.content_hash}
            />
            <ArtifactSandpackErrorReporter
              artifactId={data.artifactId}
              contentHash={payload.runtime_report_hash ?? payload.content_hash}
            />
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
