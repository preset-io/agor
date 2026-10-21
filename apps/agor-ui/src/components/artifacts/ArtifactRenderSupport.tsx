import type { ArtifactPayload } from '@agor-live/client';
import { SafetyOutlined, WarningOutlined } from '@ant-design/icons';
import { useSandpack, useSandpackConsole } from '@codesandbox/sandpack-react';
import { Tooltip, theme } from 'antd';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getDaemonUrl } from '@/config/daemon';
import { getAuthHeaders, getCurrentUserIdFromJwt } from '@/utils/authHeaders';
import { ArtifactSandpackErrorReporter } from './ArtifactSandpackErrorReporter';

/** Max console entries to send per batch, and minimum interval between sends. */
const CONSOLE_BATCH_MAX = 50;
const CONSOLE_THROTTLE_MS = 2000;
const RUNTIME_QUERY_DEFAULT_TIMEOUT_MS = 6000;

/**
 * Who reports for an artifact. The same artifact can run in more than one
 * Sandpack at once (its board card, kept hidden in Chat, and the preview), and
 * each would send its console and errors and answer agent DOM queries. Claimants
 * (a visible preview) own it while mounted, the latest first, and hand it back
 * on unmount; copies that do not claim own it only while nobody does.
 */
const runtimeClaims = new Map<string, symbol[]>();
const runtimeListeners = new Set<() => void>();
const subscribeRuntimeClaims = (listener: () => void) => {
  runtimeListeners.add(listener);
  return () => {
    runtimeListeners.delete(listener);
  };
};
const notifyRuntimeClaims = () => {
  for (const listener of runtimeListeners) listener();
};

/** Whether this copy of the artifact reports and answers queries. */
export function useArtifactRuntimeOwner(artifactId: string, claim: boolean): boolean {
  const [self] = useState(() => Symbol('artifact-runtime'));
  useEffect(() => {
    if (!claim) return;
    runtimeClaims.set(artifactId, [...(runtimeClaims.get(artifactId) ?? []), self]);
    notifyRuntimeClaims();
    return () => {
      const rest = (runtimeClaims.get(artifactId) ?? []).filter((entry) => entry !== self);
      if (rest.length > 0) runtimeClaims.set(artifactId, rest);
      else runtimeClaims.delete(artifactId);
      notifyRuntimeClaims();
    };
  }, [artifactId, claim, self]);
  const owner = useSyncExternalStore(
    subscribeRuntimeClaims,
    () => runtimeClaims.get(artifactId)?.at(-1) ?? null
  );
  return claim ? owner === self : owner === null;
}

/**
 * The console, error and DOM-query bridge for one Sandpack copy of an
 * artifact. All three stay mounted, so their state is current; only the owner
 * (`useArtifactRuntimeOwner`) sends or answers. Must be rendered inside a SandpackProvider.
 */
export function ArtifactRuntimeReporting({
  artifactId,
  contentHash,
  claim = false,
}: {
  artifactId: string;
  contentHash?: string;
  /** A visible preview: it reports while mounted. */
  claim?: boolean;
}) {
  const enabled = useArtifactRuntimeOwner(artifactId, claim);
  return (
    <>
      <ArtifactConsoleReporter
        artifactId={artifactId}
        contentHash={contentHash}
        enabled={enabled}
      />
      <ArtifactSandpackErrorReporter
        artifactId={artifactId}
        contentHash={contentHash}
        enabled={enabled}
      />
      <ArtifactRuntimeBridge artifactId={artifactId} enabled={enabled} />
    </>
  );
}

/**
 * Captures Sandpack console events and forwards them to the daemon.
 * Must be rendered inside a SandpackProvider.
 */
export function ArtifactConsoleReporter({
  artifactId,
  contentHash,
  enabled = true,
}: {
  artifactId: string;
  contentHash?: string;
  /** Off while another copy reports; what it sees meanwhile is not sent later. */
  enabled?: boolean;
}) {
  const { logs } = useSandpackConsole({ resetOnPreviewRestart: false });
  const lastSentRef = useRef(0);
  const lastSendTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      lastSentRef.current = logs.length;
      return;
    }
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
        body: JSON.stringify({ entries, content_hash: contentHash }),
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
  }, [logs, artifactId, contentHash, enabled]);

  return null;
}

export { ArtifactSandpackErrorReporter };

/**
 * Bridges agent-driven runtime queries: daemon WebSocket event → parent page →
 * Sandpack iframe via postMessage → daemon response endpoint.
 * Must be rendered inside a SandpackProvider.
 */
export function ArtifactRuntimeBridge({
  artifactId,
  enabled = true,
}: {
  artifactId: string;
  /** Off while another copy answers. */
  enabled?: boolean;
}) {
  // CRITICAL: read existing clients rather than registering a new Sandpack client;
  // the sibling SandpackPreview owns the actual iframe ref.
  const { sandpack } = useSandpack();
  const sandpackRef = useRef(sandpack);
  sandpackRef.current = sandpack;

  useEffect(() => {
    if (!enabled) return;
    const handleQuery = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        request_id: string;
        artifact_id: string;
        requested_by_user_id?: string;
        kind: string;
        args: Record<string, unknown>;
      };
      if (!detail || detail.artifact_id !== artifactId) return;

      // Fail closed before executing a query meant for another user. The daemon
      // also validates the responder, but this prevents a private DOM query from
      // running in the wrong tab at all.
      if (detail.requested_by_user_id) {
        const currentUserId = getCurrentUserIdFromJwt();
        if (!currentUserId || currentUserId !== detail.requested_by_user_id) return;
      }

      const requestId = detail.request_id;
      const currentSandpack = sandpackRef.current;
      const clientIds = Object.keys(currentSandpack.clients);
      const firstClient = clientIds.length > 0 ? currentSandpack.clients[clientIds[0]] : null;
      const target = firstClient?.iframe?.contentWindow ?? null;
      if (!target) return;

      const postResult = async (body: { ok: boolean; result?: unknown; error?: string }) => {
        try {
          await fetch(`${getDaemonUrl()}/artifacts/${artifactId}/runtime-response/${requestId}`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(body),
          });
        } catch {
          // The daemon's pending query will time out on its own.
        }
      };

      const cleanup = () => {
        window.removeEventListener('message', messageHandler);
        clearTimeout(timeout);
      };

      const messageHandler = (msgEvent: MessageEvent) => {
        const data = msgEvent.data;
        if (!data || typeof data !== 'object') return;
        if (data.type !== 'agor:result' || data.requestId !== requestId) return;
        if (msgEvent.source !== target) return;
        cleanup();
        void postResult({ ok: !!data.ok, result: data.result, error: data.error });
      };

      const timeout = setTimeout(() => {
        cleanup();
        void postResult({
          ok: false,
          error: 'Iframe did not respond before timeout (agor-runtime.js may be missing).',
        });
      }, RUNTIME_QUERY_DEFAULT_TIMEOUT_MS);

      window.addEventListener('message', messageHandler);
      target.postMessage(
        { type: 'agor:query', requestId, kind: detail.kind, args: detail.args },
        '*'
      );
    };

    window.addEventListener('agor:artifact-runtime-query', handleQuery);
    return () => window.removeEventListener('agor:artifact-runtime-query', handleQuery);
  }, [artifactId, enabled]);

  return null;
}

interface ArtifactTrustStatusIconProps {
  payload: ArtifactPayload;
  onTrustClick?: () => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * Compact artifact trust/status affordance for headers.
 *
 * Uses warning/safety glyphs rather than a lock so the board-card lock can
 * unambiguously mean "this artifact card cannot be moved/resized."
 */
export function ArtifactTrustStatusIcon({
  payload,
  onTrustClick,
  className,
  style,
}: ArtifactTrustStatusIconProps) {
  const { token } = theme.useToken();
  const state = payload.trust_state;
  if (state === 'no_secrets_needed') return null;

  const isUntrusted = state === 'untrusted';
  const isTrusted = state === 'trusted';
  const isSelf = state === 'self';
  const scopeLabel =
    payload.trust_scope === 'instance'
      ? 'instance-wide'
      : payload.trust_scope === 'author'
        ? 'this author'
        : payload.trust_scope === 'session'
          ? 'just-once'
          : 'this artifact';
  const title = isUntrusted
    ? onTrustClick
      ? 'Click to review and grant trust so secrets are injected'
      : 'Secrets are locked until trust is granted'
    : isTrusted
      ? `Secrets injected — trust granted for ${scopeLabel}`
      : isSelf
        ? 'You created this artifact; secrets are injected'
        : 'Artifact trust status';
  const color = isUntrusted ? token.colorWarning : isTrusted ? token.colorSuccess : token.colorInfo;
  const backgroundColor = isUntrusted
    ? token.colorWarningBg
    : isTrusted
      ? token.colorSuccessBg
      : token.colorInfoBg;
  const icon = isUntrusted ? <WarningOutlined /> : <SafetyOutlined />;
  const commonStyle: CSSProperties = {
    width: 20,
    height: 20,
    borderRadius: 3,
    backgroundColor,
    border: `1px solid ${color}`,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    padding: 0,
    appearance: 'none',
    color,
    fontSize: 12,
    lineHeight: 1,
    ...style,
  };

  const iconElement =
    isUntrusted && onTrustClick ? (
      <button
        type="button"
        className={className}
        aria-label="Review artifact trust"
        style={{
          ...commonStyle,
          backgroundClip: 'padding-box',
          cursor: 'pointer',
          font: 'inherit',
        }}
        onClick={(e) => {
          e.stopPropagation();
          onTrustClick();
        }}
      >
        {icon}
      </button>
    ) : (
      <span className={className} style={commonStyle}>
        {icon}
      </span>
    );

  return <Tooltip title={title}>{iconElement}</Tooltip>;
}
