import {
  CheckCircleOutlined,
  CloseOutlined,
  LoadingOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Space, Tooltip } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useConnectionState } from '../../contexts/ConnectionContext';
import { Tag } from '../Tag';

export interface ConnectionStatusProps {
  connected: boolean;
  connecting: boolean;
  onRetry?: () => void;
}

/**
 * Threshold for escalating a stuck "Reconnecting" tag to the terminal
 * "Can't reconnect" red tag. Socket.io's `reconnectionDelayMax` is 5s
 * (packages/core/src/api/index.ts) and a healthy reconnect (daemon restart,
 * wifi flap, etc.) finishes well under 10s. Once we've spent 20s spinning,
 * the user is almost certainly looking at the stuck-reconnect bug pattern
 * (token expired, refresh failed transiently, no auto-recovery path), and
 * telling them "click to reload" is more honest than continuing to imply
 * recovery is imminent.
 */
const STUCK_RECONNECT_MS = 20_000;

/**
 * Disconnect duration above which we surface the "Reconnected — refresh?"
 * cue on the next successful reconnect. Below this, the user almost
 * certainly didn't miss anything material (the disconnect grace window in
 * useAgorClient is 1.5s; real-time events that fire in a 1–10s gap are rare
 * enough not to warrant nagging). At 10s we start to plausibly miss
 * messages, comments, or session updates that the byId caches won't notice
 * are gone.
 */
const STALE_THRESHOLD_MS = 10_000;

/**
 * How long the "Reconnected — refresh?" cue stays in the navbar before
 * auto-dismissing. The cue is a *suggestion*, not a requirement — the
 * around-hook + per-conversation resync listeners catch the common cases;
 * this nudges the user only when the gap was long enough that something
 * subtle might have slipped through. 60s is long enough to notice and
 * decide; short enough that a tab left open all day doesn't accumulate a
 * permanent yellow tag.
 */
const STALE_AUTO_DISMISS_MS = 60_000;

/**
 * ConnectionStatus — navbar tag that communicates connection state and the
 * action the user can take. The component is intentionally honest about
 * what's recoverable on its own (transient reconnects) vs. what needs
 * user-driven intervention (terminal stuck-state, post-long-gap data
 * staleness).
 *
 * State machine, in priority order:
 *
 * 1. **Out of sync** (red, click → reload) — daemon SHA changed under us.
 *    Reload is mandatory; UI bundle assumes a contract that's no longer there.
 * 2. **Can't reconnect** (red, click → reload) — we've been `connecting`
 *    for > STUCK_RECONNECT_MS without succeeding. Honest "this isn't
 *    fixing itself" cue.
 * 3. **Disconnected** (red, click → retry) — `!connected && !connecting`,
 *    typically socket-server-disconnect after the manual-reconnect cap is
 *    hit.
 * 4. **Reconnecting** (yellow, click → retry) — the normal transient
 *    reconnect window. Click is a manual escape hatch in case socket.io's
 *    own retry is on a slow cycle.
 * 5. **Reconnected — refresh?** (yellow info, click → reload, × dismiss) —
 *    just reconnected after a gap ≥ STALE_THRESHOLD_MS. The byId caches
 *    and reactive sessions auto-resync for the common cases, but a long
 *    gap can drop subtle updates (sessions removed/added, comments,
 *    permission changes). Suggested-not-required.
 * 6. **Connected** (green, ephemeral) — brief success flash after a normal
 *    reconnect that didn't qualify as stale.
 * 7. **Nothing** — steady-state connected, no clutter.
 */
export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  connected,
  connecting,
  onRetry,
}) => {
  const { outOfSync, capturedSha, currentSha } = useConnectionState();

  // Timestamp the user lost connection (entered `connecting && !connected`).
  // Null when we're not currently disconnected. Survives across renders so
  // the second-tick effect below can derive stuck-ness without re-recording.
  const disconnectStartedAtRef = useRef<number | null>(null);
  const [disconnectStartedAt, setDisconnectStartedAt] = useState<number | null>(null);

  // Reflects the most recent reconnect we judged "stale enough to surface a
  // refresh cue for." Set when connection comes back after ≥ STALE_THRESHOLD_MS;
  // cleared on user action (click reload or click ×) or after auto-dismiss.
  const [staleSince, setStaleSince] = useState<number | null>(null);

  // Brief green "Connected" flash after a short reconnect (< stale threshold)
  // so the user gets a quick "we noticed and fixed it" confirmation when
  // there's no other cue to render. Long reconnects show the actionable
  // "Reconnected — refresh?" cue instead, so the two never compete.
  const [showConnected, setShowConnected] = useState(false);

  // Forces re-render every second while `connecting`, so the stuck-reconnect
  // escalation fires without us having to push timing state up into
  // useAgorClient. Cheap (the navbar is the only consumer); only ticks when
  // we're actually waiting.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!connecting) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [connecting]);

  // Track the disconnect → reconnect transition. We record the start of
  // every reconnect attempt and, when `connected` flips back to true,
  // compute the duration to decide whether the user might have missed
  // events. Ref + state in lockstep — ref so the timing survives a tear-
  // down between effect runs, state so renders see the up-to-date value.
  useEffect(() => {
    if (connecting && !connected) {
      if (disconnectStartedAtRef.current === null) {
        const now = Date.now();
        disconnectStartedAtRef.current = now;
        setDisconnectStartedAt(now);
      }
      return;
    }
    if (connected && disconnectStartedAtRef.current !== null) {
      const downFor = Date.now() - disconnectStartedAtRef.current;
      disconnectStartedAtRef.current = null;
      setDisconnectStartedAt(null);
      if (downFor >= STALE_THRESHOLD_MS) {
        setStaleSince(Date.now());
      } else {
        setShowConnected(true);
      }
    }
  }, [connecting, connected]);

  // Hide the green flash after a short delay. Long enough to register,
  // short enough not to clutter.
  useEffect(() => {
    if (!showConnected) return;
    const id = setTimeout(() => setShowConnected(false), 3000);
    return () => clearTimeout(id);
  }, [showConnected]);

  // Auto-dismiss the stale cue after STALE_AUTO_DISMISS_MS — a long-open
  // tab shouldn't accumulate a yellow nag forever. User action (reload or
  // dismiss) also clears it.
  useEffect(() => {
    if (staleSince === null) return;
    const id = setTimeout(() => setStaleSince(null), STALE_AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [staleSince]);

  // --- 1. Out of sync (highest priority) ---
  // Backend redeployed under us. Reload is mandatory because the bundled UI
  // may reference removed services. No auto-reload, since it would nuke a
  // half-typed message or open modal.
  if (outOfSync) {
    const tooltipTitle =
      capturedSha && currentSha
        ? `Daemon was upgraded from ${capturedSha} to ${currentSha} since this tab loaded. Click to reload and pick up the latest UI. Anything unsaved (form text, etc.) will be lost.`
        : 'Backend was updated — click to reload for the latest UI. Anything unsaved will be lost.';
    return (
      <Tooltip title={tooltipTitle} placement="bottom">
        <Tag
          icon={<ReloadOutlined />}
          color="warning"
          onClick={() => window.location.reload()}
          style={{ margin: 0, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        >
          <Space size={4}>
            <span>Out of sync — refresh</span>
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  const stuckTooLong =
    connecting &&
    disconnectStartedAt !== null &&
    Date.now() - disconnectStartedAt >= STUCK_RECONNECT_MS;

  // --- 2. Can't reconnect (escalated stuck state) ---
  // Honest message: we tried for STUCK_RECONNECT_MS, it isn't working,
  // here's the button that actually fixes it. Page reload is the same
  // thing the user would do manually; making it one click is the point.
  if (stuckTooLong) {
    return (
      <Tooltip
        title="Can't reconnect to the daemon. Click to reload the page — anything unsaved will be lost."
        placement="bottom"
      >
        <Tag
          icon={<ReloadOutlined />}
          color="error"
          onClick={() => window.location.reload()}
          style={{ margin: 0, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        >
          <Space size={4}>
            <span>Can't reconnect — reload</span>
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  // --- 3. Disconnected (transient, before escalation) ---
  // Matches the previous behavior. The retry button kicks `client.io.connect()`
  // via useAgorClient's `retryConnection`.
  if (!connected && !connecting) {
    return (
      <Tooltip title="Connection lost. Click to retry connection." placement="bottom">
        <Tag
          icon={<WarningOutlined />}
          color="error"
          onClick={onRetry}
          style={{ margin: 0, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        >
          <Space size={4}>
            <span>Disconnected</span>
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  // --- 4. Reconnecting (now clickable for manual retry) ---
  // Used to be passive. The click handler gives the user an escape hatch
  // when socket.io's exponential backoff is on a 5s sleep — instead of
  // sitting and waiting, they can force a retry attempt right now.
  if (connecting) {
    return (
      <Tooltip title="Reconnecting to daemon… Click to retry immediately." placement="bottom">
        <Tag
          icon={<LoadingOutlined spin />}
          color="warning"
          onClick={onRetry}
          style={{ margin: 0, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        >
          <Space size={4}>
            <span>Reconnecting</span>
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  // --- 5. Reconnected — refresh? (post-long-gap cue) ---
  // Suggested, not required. The around-hook + per-conversation resync
  // listeners already pick up the common cases; this nudges the user only
  // when the gap was long enough that something subtle (a removed session,
  // a comment, a permission change) might have slipped through. Reload is
  // the simplest universal "rehydrate everything" — same action the user
  // would take manually.
  if (staleSince !== null) {
    return (
      <Tooltip
        title="You were disconnected long enough that some data may be stale. Click to reload, or × to dismiss."
        placement="bottom"
      >
        <Tag
          icon={<ReloadOutlined />}
          color="warning"
          onClick={() => window.location.reload()}
          style={{ margin: 0, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        >
          <Space size={4}>
            <span>Reconnected — refresh?</span>
            <CloseOutlined
              aria-label="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                setStaleSince(null);
              }}
              style={{ fontSize: 10, opacity: 0.7 }}
            />
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  // --- 6. Connected (ephemeral success flash for short reconnects) ---
  // Only set when the gap was below STALE_THRESHOLD_MS — long-gap
  // reconnects route to "Reconnected — refresh?" above instead, so the
  // two cues never compete.
  if (showConnected) {
    return (
      <Tooltip title="Connected to daemon" placement="bottom">
        <Tag
          icon={<CheckCircleOutlined />}
          color="success"
          style={{ margin: 0, display: 'flex', alignItems: 'center' }}
        >
          <Space size={4}>
            <span>Connected</span>
          </Space>
        </Tag>
      </Tooltip>
    );
  }

  // --- 7. Nothing (steady state) ---
  return null;
};
