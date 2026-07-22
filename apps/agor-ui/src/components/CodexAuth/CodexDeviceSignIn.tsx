import type { AgorClient, CodexDeviceAuthStatus } from '@agor-live/client';
import { CheckCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import { Alert, Button, Typography, theme } from 'antd';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const { Text } = Typography;
const { useToken } = theme;

/**
 * Where a gated ChatGPT account can go instead of device sign-in. Kept neutral
 * (not tied to any one surface's method enum) so both the onboarding wizard and
 * the settings pane can map it onto their own auth-method state.
 */
export type CodexAuthFallback = 'import' | 'api-key';

const DEVICE_STATUS_POLL_MS = 2000;

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(Math.floor(remainingMs / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export interface CodexDeviceSignInProps {
  client: AgorClient | null;
  /** Fired once the daemon confirms tokens were saved for this user. */
  onVerified: () => void;
  /** Switch to another codex auth method (gated-account fallback). */
  onUseFallback: (target: CodexAuthFallback) => void;
  /**
   * Request a code as soon as the pane mounts. The onboarding wizard reveals
   * this pane only on an explicit "Sign in with ChatGPT" choice, so eager start
   * is right there. A management surface (settings) mounts it as one tab among
   * several, so it defaults to a deliberate button press instead of firing an
   * OpenAI device request every time the tab is viewed. A still-live *pending*
   * attempt is always adopted regardless of this flag; a terminal *success* is
   * adopted only when autoStart is true (the wizard, which reflects the verified
   * state after toggling away and back). A management surface tells its
   * connection story via a separate probe, so it must not adopt a stale success
   * — that would wall off re-signing-in until the daemon prunes the attempt.
   */
  autoStart?: boolean;
}

/**
 * Self-contained device-code pane: requests a code, shows it with the
 * verification link and a countdown, and polls the daemon for approval.
 * Memoized with its own state so the 1s countdown and 2s status polls
 * re-render only this pane, never the surface that hosts it.
 */
export const CodexDeviceSignIn = memo(function CodexDeviceSignIn({
  client,
  onVerified,
  onUseFallback,
  autoStart = true,
}: CodexDeviceSignInProps) {
  const { token } = useToken();
  const [status, setStatus] = useState<CodexDeviceAuthStatus>({ phase: 'idle' });
  const [starting, setStarting] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  const deviceService = useMemo(
    () =>
      client
        ? (client.service('codex-auth/device') as unknown as {
            create(data: Record<string, never>): Promise<unknown>;
            find(): Promise<unknown>;
          })
        : null,
    [client]
  );

  // Tracks the service the pane currently talks to, so an in-flight
  // requestCode issued against a swapped-out client can't land its state
  // updates over the replacement's. A layout effect syncs the identity
  // before paint and before the passive effects below; resetting `starting`
  // here matters because a stale request's guarded finally deliberately
  // won't clear it, and a replacement that ADOPTS an attempt never calls
  // requestCode — without the reset the spinner would cover a live code.
  // Reset status/countdown too: a client/identity swap must not leave the
  // previous client's pending code (and its polling loop) on screen — the
  // adopt-or-request effect below then decides what THIS service should show.
  // Without this, an autoStart=false surface that doesn't re-request would
  // keep displaying and polling the old code against the new service.
  const latestServiceRef = useRef(deviceService);
  useLayoutEffect(() => {
    latestServiceRef.current = deviceService;
    setStarting(false);
    setStatus({ phase: 'idle' });
    setRemainingMs(null);
  }, [deviceService]);

  const requestCode = useCallback(async () => {
    if (!deviceService) return;
    setStarting(true);
    try {
      const next = (await deviceService.create({})) as CodexDeviceAuthStatus;
      if (latestServiceRef.current !== deviceService) return;
      setStatus(next);
    } catch (err) {
      if (latestServiceRef.current !== deviceService) return;
      setStatus({
        phase: 'error',
        hint:
          err instanceof Error && err.message
            ? err.message
            : 'Could not start the ChatGPT sign-in — try again.',
      });
    } finally {
      if (latestServiceRef.current === deviceService) setStarting(false);
    }
  }, [deviceService]);

  // On mount (and on client swap), adopt a still-live attempt (user toggled
  // away and back) instead of burning a fresh code; otherwise request one.
  // Continuations are guarded by both `cancelled` (StrictMode / normal cleanup)
  // and the service ref: React runs the client-swap layout reset before this
  // effect's cleanup, so a stale find() resolving in that window must not
  // restore the previous client's code — matching requestCode's own guard.
  useEffect(() => {
    if (!deviceService) return;
    let cancelled = false;
    const stillCurrent = () => !cancelled && latestServiceRef.current === deviceService;
    void (async () => {
      try {
        const existing = (await deviceService.find()) as CodexDeviceAuthStatus;
        if (!stillCurrent()) return;
        // Adopt a live pending attempt always; adopt a terminal success only for
        // eager (wizard) mounts — a management surface must stay able to restart.
        if (existing.phase === 'pending' || (existing.phase === 'success' && autoStart)) {
          setStatus(existing);
          return;
        }
      } catch {
        // No adoptable attempt — fall through to a fresh request.
      }
      if (stillCurrent() && autoStart) await requestCode();
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceService, requestCode, autoStart]);

  // Poll while pending; terminal phases stop the loop. A self-scheduling
  // timeout (next poll armed only after the previous response lands) keeps
  // slow responses from overlapping and regressing a terminal phase with an
  // out-of-order pending. Identity-preserving setState keeps unchanged polls
  // from re-rendering even this pane.
  useEffect(() => {
    if (status.phase !== 'pending' || !deviceService) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = (await deviceService.find()) as CodexDeviceAuthStatus;
        if (cancelled || latestServiceRef.current !== deviceService) return;
        setStatus((prev) =>
          prev.phase === next.phase && prev.userCode === next.userCode && prev.hint === next.hint
            ? prev
            : next
        );
      } catch {
        // Transient — keep polling until the code expires.
      }
      if (!cancelled) timer = setTimeout(tick, DEVICE_STATUS_POLL_MS);
    };
    timer = setTimeout(tick, DEVICE_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status.phase, deviceService]);

  // 1s countdown while a code is live.
  useEffect(() => {
    if (status.phase !== 'pending' || !status.expiresAt) {
      setRemainingMs(null);
      return;
    }
    const expiresAtMs = Date.parse(status.expiresAt);
    const update = () => setRemainingMs(Math.max(expiresAtMs - Date.now(), 0));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [status.phase, status.expiresAt]);

  useEffect(() => {
    if (status.phase === 'success') onVerified();
  }, [status.phase, onVerified]);

  if (starting || (status.phase === 'idle' && autoStart)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0' }}>
        <LoadingOutlined style={{ color: token.colorTextTertiary, fontSize: 14 }} />
        <Text style={{ color: token.colorTextTertiary, fontSize: 13 }}>
          {client ? 'Getting your sign-in code…' : 'Waiting for the server connection…'}
        </Text>
      </div>
    );
  }

  // Deliberate-start surfaces (autoStart=false) with no adoptable attempt: offer
  // the button rather than firing an OpenAI device request on mount.
  if (status.phase === 'idle') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
        <Button type="primary" disabled={!client} onClick={requestCode}>
          Get a sign-in code
        </Button>
        {!client && (
          <Text style={{ color: token.colorTextTertiary, fontSize: 13 }}>
            Waiting for the server connection…
          </Text>
        )}
      </div>
    );
  }

  if (status.phase === 'pending') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
        <Text style={{ color: token.colorTextSecondary, fontSize: 13 }}>
          Open the link below, sign in to ChatGPT, and enter this one-time code:
        </Text>
        <Text
          copyable
          aria-label="ChatGPT sign-in code"
          style={{
            color: token.colorText,
            fontFamily: 'monospace',
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: 4,
          }}
        >
          {status.userCode}
        </Text>
        {status.verificationUrl && (
          <Typography.Link
            href={status.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 13 }}
          >
            Open {status.verificationUrl} →
          </Typography.Link>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LoadingOutlined style={{ color: token.colorTextTertiary, fontSize: 13 }} />
          <Text style={{ color: token.colorTextTertiary, fontSize: 12 }}>
            Waiting for approval — we finish automatically once you approve.
            {remainingMs !== null && ` Code expires in ${formatCountdown(remainingMs)}.`}
          </Text>
        </div>
      </div>
    );
  }

  if (status.phase === 'success') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0' }}>
        <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 14 }} />
        <Text style={{ color: token.colorSuccess, fontSize: 13 }}>
          {status.hint ?? 'Signed in with ChatGPT.'}
        </Text>
      </div>
    );
  }

  if (status.phase === 'unavailable') {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ fontSize: 12 }}
        message="Device sign-in is turned off for this ChatGPT account"
        description={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>
              Personal accounts: enable it under ChatGPT Settings → Security → “Device code
              authorization for Codex”, then try again. Workspace accounts: a workspace admin has to
              enable it. Either way, the two options below work right now.
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Button size="small" onClick={() => onUseFallback('import')}>
                Paste a login file
              </Button>
              <Button size="small" onClick={() => onUseFallback('api-key')}>
                Use an API key
              </Button>
              <Button size="small" type="text" onClick={requestCode}>
                Try again
              </Button>
            </div>
          </div>
        }
      />
    );
  }

  // expired / error
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
      <Alert
        type={status.phase === 'expired' ? 'warning' : 'error'}
        showIcon
        style={{ fontSize: 12 }}
        message={
          status.hint ??
          (status.phase === 'expired' ? 'The sign-in code expired.' : 'The ChatGPT sign-in failed.')
        }
      />
      <div>
        <Button size="small" onClick={requestCode}>
          Get a new code
        </Button>
      </div>
    </div>
  );
});
