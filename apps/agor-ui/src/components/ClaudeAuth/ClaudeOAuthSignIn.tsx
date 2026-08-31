import type { AgorClient, ClaudeOAuthStatus } from '@agor-live/client';
import { CheckCircleOutlined, ExportOutlined, LoadingOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Input, Space, Typography, theme } from 'antd';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIdentityGuardedAsync } from '../../hooks/useIdentityGuardedAsync';

const { Text } = Typography;
const { useToken } = theme;

export interface ClaudeOAuthSignInProps {
  client: AgorClient | null;
  /** Whether the parent currently resolves this user to a subscription login. */
  connected?: boolean;
  /** Fired once the daemon confirms tokens were saved for this user. */
  onVerified: () => void;
  /**
   * Request an authorize link as soon as the pane mounts. The onboarding wizard
   * reveals this pane on an explicit "Sign in with Claude" choice, so eager
   * start is right there; a management surface (settings) mounts it as one tab
   * among several, so it defaults to a deliberate button press. A still-live
   * `awaiting_code` attempt is always adopted; a terminal `success` is adopted
   * only when autoStart is true (the wizard reflecting a verified state).
   */
  autoStart?: boolean;
  /** Cancels caller-private OAuth continuations when socket authority changes. */
  operationScope?: readonly unknown[] | null;
}

/**
 * Self-contained Claude subscription sign-in pane. Unlike the Codex device flow,
 * Anthropic has no device endpoint: the daemon issues an authorize URL, the user
 * approves in the browser and pastes the `CODE#STATE` string back here, and the
 * daemon exchanges it. Memoized with its own state so its input keystrokes never
 * re-render the surface that hosts it.
 */
export const ClaudeOAuthSignIn = memo(function ClaudeOAuthSignIn({
  client,
  connected = false,
  onVerified,
  autoStart = true,
  operationScope,
}: ClaudeOAuthSignInProps) {
  const { token } = useToken();
  const [status, setStatus] = useState<ClaudeOAuthStatus>({ phase: 'idle' });
  const [starting, setStarting] = useState(false);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const wasConnected = useRef(connected);

  // A successful attempt remains queryable for an hour. When logout changes the
  // persisted method, do not keep rendering that stale success as connected.
  useEffect(() => {
    if (wasConnected.current && !connected) {
      setStatus({ phase: 'idle' });
      setCode('');
      setSubmitError(null);
    }
    wasConnected.current = connected;
  }, [connected]);

  const service = useMemo(
    () =>
      client
        ? (client.service('claude-auth/oauth') as unknown as {
            create(data: { code?: string }): Promise<unknown>;
            find(): Promise<unknown>;
          })
        : null,
    [client]
  );
  const effectiveOperationScope =
    operationScope === undefined ? ([service] as const) : operationScope;
  const operationAvailable = effectiveOperationScope !== null;

  // Guard every request against the service the pane currently talks to: an
  // in-flight call issued against a swapped-out client must not land its state
  // over the replacement's.
  const { run } = useIdentityGuardedAsync([service, ...(effectiveOperationScope ?? [null])], () => {
    setStarting(false);
    setStatus({ phase: 'idle' });
    setCode('');
    setSubmitError(null);
  });

  const requestLink = useCallback(async () => {
    if (!service || !operationAvailable) return;
    setStarting(true);
    setSubmitError(null);
    setCode('');
    try {
      const next = (await run(() => service.create({}))) as ClaudeOAuthStatus;
      setStatus(next);
    } catch (err) {
      setStatus({
        phase: 'error',
        hint:
          err instanceof Error && err.message
            ? err.message
            : 'Could not start the Claude sign-in — try again.',
      });
    } finally {
      setStarting(false);
    }
  }, [service, run, operationAvailable]);

  // On mount (and on client swap), adopt a still-live attempt instead of burning
  // a fresh link; otherwise request one when autoStart is set.
  useEffect(() => {
    if (!service || !operationAvailable) return;
    let cancelled = false;
    void (async () => {
      try {
        const existing = (await run(() => service.find())) as ClaudeOAuthStatus;
        if (cancelled) return;
        if (
          existing.phase === 'awaiting_code' ||
          existing.phase === 'exchanging' ||
          (existing.phase === 'success' && autoStart)
        ) {
          setStatus(existing);
          return;
        }
      } catch {
        // No adoptable attempt — fall through to a fresh request.
      }
      if (!cancelled && autoStart) await requestLink();
    })();
    return () => {
      cancelled = true;
    };
  }, [service, requestLink, autoStart, run, operationAvailable]);

  // A remounted pane can adopt an exchange whose create request is still owned
  // by the previous component/tab. No service event is published for this
  // caller-private control plane, so poll only while that adopted phase is
  // active and render the terminal result when the owner request completes.
  useEffect(() => {
    if (!service || !operationAvailable || status.phase !== 'exchanging') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const latest = (await run(() => service.find())) as ClaudeOAuthStatus;
        if (cancelled) return;
        setStatus(latest);
        if (latest.phase === 'exchanging') timer = setTimeout(poll, 500);
      } catch {
        if (!cancelled) timer = setTimeout(poll, 500);
      }
    };

    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [service, status.phase, run, operationAvailable]);

  const submitCode = useCallback(async () => {
    if (!service || !operationAvailable || !code.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const next = (await run(() => service.create({ code: code.trim() }))) as ClaudeOAuthStatus;
      setStatus(next);
      if (next.phase === 'success') setCode('');
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'That code could not be completed — start over and try again.';
      // Malformed/wrong-state pastes remain retryable daemon-side. Once an
      // exchange began, however, rejection/ambiguity/persistence failures are
      // terminal because the code may be spent. Reconcile the daemon phase so
      // this mounted pane exposes Start over instead of trapping the user on
      // the old awaiting-code form.
      try {
        const latest = (await run(() => service.find())) as ClaudeOAuthStatus;
        if (latest.phase !== 'awaiting_code' && latest.phase !== 'exchanging') {
          setStatus(latest);
          setCode('');
          setSubmitError(null);
        } else {
          setSubmitError(message);
        }
      } catch {
        setSubmitError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }, [service, code, run, operationAvailable]);

  useEffect(() => {
    if (status.phase === 'success') onVerified();
  }, [status.phase, onVerified]);

  if (starting || (status.phase === 'idle' && autoStart)) {
    return (
      <Flex align="center" gap={8} style={{ padding: '12px 0' }}>
        <LoadingOutlined style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }} />
        <Text type="secondary">
          {client ? 'Preparing your Claude sign-in…' : 'Waiting for the server connection…'}
        </Text>
      </Flex>
    );
  }

  if (status.phase === 'idle') {
    return (
      <Flex align="center" gap={8} style={{ padding: '4px 0' }}>
        <Button type="primary" disabled={!client || !operationAvailable} onClick={requestLink}>
          Sign in with Claude
        </Button>
        {!client && <Text type="secondary">Waiting for the server connection…</Text>}
      </Flex>
    );
  }

  if (status.phase === 'awaiting_code' || status.phase === 'exchanging') {
    const busy = submitting || status.phase === 'exchanging';
    return (
      <Space orientation="vertical" size={10} style={{ display: 'flex', padding: '4px 0' }}>
        <Text type="secondary">
          Open the Claude sign-in page, approve access, then paste the code it shows back here:
        </Text>
        {status.verificationUrl && (
          <Button
            type="primary"
            href={status.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            icon={<ExportOutlined />}
          >
            Open the Claude sign-in page
          </Button>
        )}
        <Space.Compact style={{ width: '100%' }}>
          <Input
            aria-label="Claude authorization code"
            placeholder="Paste the code (looks like CODE#STATE)"
            value={code}
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
            onPressEnter={() => void submitCode()}
          />
          <Button type="primary" loading={busy} disabled={!code.trim()} onClick={submitCode}>
            Complete sign-in
          </Button>
        </Space.Compact>
        {submitError && <Alert type="error" showIcon message={submitError} />}
      </Space>
    );
  }

  if (status.phase === 'success') {
    return (
      <Flex align="center" gap={8} style={{ padding: '12px 0' }}>
        <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: token.fontSizeSM }} />
        <Text style={{ color: token.colorSuccess }}>{status.hint ?? 'Signed in with Claude.'}</Text>
      </Flex>
    );
  }

  // expired / error
  return (
    <Space orientation="vertical" size={10} style={{ display: 'flex', padding: '4px 0' }}>
      <Alert
        type={status.phase === 'expired' ? 'warning' : 'error'}
        showIcon
        message={
          status.hint ??
          (status.phase === 'expired' ? 'The sign-in link expired.' : 'The Claude sign-in failed.')
        }
      />
      <div>
        <Button onClick={requestLink}>Start over</Button>
      </div>
    </Space>
  );
});
