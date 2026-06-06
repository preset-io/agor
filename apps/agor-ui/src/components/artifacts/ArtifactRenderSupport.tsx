import type { ArtifactPayload } from '@agor-live/client';
import { LockOutlined, SafetyOutlined } from '@ant-design/icons';
import { useSandpack, useSandpackConsole } from '@codesandbox/sandpack-react';
import { Tag, Tooltip } from 'antd';
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
export function ArtifactConsoleReporter({ artifactId }: { artifactId: string }) {
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
 * Captures Sandpack bundler/runtime errors and forwards them to the daemon.
 * Must be rendered inside a SandpackProvider.
 */
export function ArtifactSandpackErrorReporter({ artifactId }: { artifactId: string }) {
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
        body: JSON.stringify(payload),
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
  }, [sandpack.error, sandpack.status, artifactId]);

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

interface ArtifactTrustBadgeOptions {
  className?: string;
  style?: CSSProperties;
}

export function renderArtifactTrustBadge(
  payload: ArtifactPayload,
  onTrustClick?: () => void,
  options: ArtifactTrustBadgeOptions = {}
) {
  const tagStyle = { fontSize: 10, marginLeft: 4, ...options.style };
  const state = payload.trust_state;
  if (state === 'no_secrets_needed') return null;
  if (state === 'self') {
    return (
      <Tag color="blue" icon={<SafetyOutlined />} style={tagStyle}>
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
        <Tag color="green" icon={<SafetyOutlined />} style={tagStyle}>
          Trusted
        </Tag>
      </Tooltip>
    );
  }

  return (
    <Tooltip title="Click to review and grant trust so secrets are injected">
      <Tag
        color="orange"
        icon={<LockOutlined />}
        className={onTrustClick ? options.className : undefined}
        style={{ ...tagStyle, cursor: onTrustClick ? 'pointer' : undefined }}
        onClick={
          onTrustClick
            ? (e) => {
                e.stopPropagation();
                onTrustClick();
              }
            : undefined
        }
      >
        Untrusted
      </Tag>
    </Tooltip>
  );
}
