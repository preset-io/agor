import type { ArtifactPayload } from '@agor-live/client';
import { SafetyOutlined, WarningOutlined } from '@ant-design/icons';
import { useSandpack, useSandpackConsole } from '@codesandbox/sandpack-react';
import { Tooltip, theme } from 'antd';
import type { CSSProperties } from 'react';
import { useEffect, useRef } from 'react';
import { getDaemonUrl } from '@/config/daemon';
import { getAuthHeaders, getCurrentUserIdFromJwt } from '@/utils/authHeaders';

/** Max console entries to send per batch, and minimum interval between sends. */
const CONSOLE_BATCH_MAX = 50;
const CONSOLE_THROTTLE_MS = 2000;
const SANDPACK_ERROR_THROTTLE_MS = 1000;
const RUNTIME_QUERY_DEFAULT_TIMEOUT_MS = 6000;

/**
 * Captures Sandpack console events and forwards them to the daemon.
 * Must be rendered inside a SandpackProvider.
 */
export function ArtifactConsoleReporter({
  artifactId,
  contentHash,
}: {
  artifactId: string;
  contentHash?: string;
}) {
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
  }, [logs, artifactId, contentHash]);

  return null;
}

/**
 * Captures Sandpack bundler/runtime errors and forwards them to the daemon.
 * Must be rendered inside a SandpackProvider.
 */
export function ArtifactSandpackErrorReporter({
  artifactId,
  contentHash,
}: {
  artifactId: string;
  contentHash?: string;
}) {
  const { sandpack } = useSandpack();
  const lastSentRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSendRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const stateKey = `${sandpack.error?.message ?? ''}\0${sandpack.status}`;
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
        body: JSON.stringify({ ...payload, content_hash: contentHash }),
      }).catch(() => {});
    };

    if (timerRef.current) clearTimeout(timerRef.current);
    pendingSendRef.current = sendError;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      sendError();
    }, SANDPACK_ERROR_THROTTLE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        pendingSendRef.current?.();
      }
    };
  }, [sandpack.error, sandpack.status, artifactId, contentHash]);

  return null;
}

/**
 * Bridges agent-driven runtime queries: daemon WebSocket event → parent page →
 * Sandpack iframe via postMessage → daemon response endpoint.
 * Must be rendered inside a SandpackProvider.
 */
export function ArtifactRuntimeBridge({ artifactId }: { artifactId: string }) {
  // CRITICAL: read existing clients rather than registering a new Sandpack client;
  // the sibling SandpackPreview owns the actual iframe ref.
  const { sandpack } = useSandpack();
  const sandpackRef = useRef(sandpack);
  sandpackRef.current = sandpack;

  useEffect(() => {
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
  }, [artifactId]);

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
