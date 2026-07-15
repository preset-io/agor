// biome-ignore-all lint/plugin/noHardcodedColorLiteral: xterm requires an exact ANSI terminal palette
// biome-ignore-all lint/plugin/noHardcodedColorProperty: xterm requires compound terminal overlay colors
/**
 * EmbeddedTerminal — an xterm.js terminal rendered INLINE inside a session
 * pane (not in a modal), bound to the user's existing Zellij terminal
 * channel.
 *
 * Used by the Claude Code CLI adapter so the conversation pane can host the
 * live `claude` REPL directly, fulfilling the analysis doc's "Terminal view"
 * (and, when shown alongside the conversation message feed, the spec's
 * developer-affordance split view).
 *
 * Architecture:
 *   - Calls `terminals.create({ branchId })` to ensure the user's Zellij
 *     executor exists (idempotent — returns existing connection if running).
 *   - Joins the `user/<id>/terminal` channel and renders the live PTY stream.
 *   - If `focusTabName` is provided, emits a `terminal:tab` { action: 'focus' }
 *     so the embedded view lands on the correct CLI session tab.
 *
 * Mirroring with the popout modal: since both views connect to the SAME
 * channel, opening both at once mirrors output across them — this is the
 * spec's "split view" for debugging. Input from either flows to the same
 * Zellij session, which is the desired behavior (typing somewhere in the
 * conversation hits the same `claude` process the modal sees).
 *
 * This is a minimal extraction from TerminalModal — the modal-specific
 * concerns (close-confirm, role-gating UI) are kept in TerminalModal.tsx;
 * this component is just the xterm + channel-binding core.
 */

import type { AgorClient, UserID } from '@agor-live/client';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { Badge } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { loadWebglRenderer } from '../../utils/xtermWebgl';
import '@xterm/xterm/css/xterm.css';

export interface EmbeddedTerminalProps {
  client: AgorClient | null;
  userId?: string | null;
  /** Branch to associate with — passed to the terminals.create call so the
   *  Zellij session gets the right cwd / env. */
  branchId?: string;
  /** When provided, the embedded view emits a Zellij `focus` on this tab name
   *  once connected. Use the CLI session's `cli-<short>` tab name. */
  focusTabName?: string;
  /**
   * For `claude-code-cli` sessions: pass the Agor session id here. The
   * server looks up `cli_state` + `model_config`, builds the safe
   * `claude --session-id <X> ...` argv, and emits a create-with-command
   * `terminal:tab` event — guaranteeing the cli-XXX tab exists with
   * `claude` running inside even on first-run / cold-start. Without
   * this, the cold-start path emits a `focus` for a tab that may not
   * yet exist (because `onCliSessionCreated`'s dispatch raced an
   * absent executor) and the user sees a bash prompt instead of the
   * REPL. Browser never sees raw argv — the daemon builds it server-side.
   */
  ensureCliSessionId?: string;
  /** Fixed pixel height. Default 480. Ignored when `fill` is true. */
  height?: number;
  /** When true, the terminal flexes to fill its parent's available
   *  height/width (use inside a flex container with `flex: 1`). When
   *  false, the terminal uses the fixed `height` prop. */
  fill?: boolean;
  /**
   * Whether the embedded view is currently visible to the user (as opposed
   * to hidden via `display:none` because a sibling view is active).
   *
   * When this flips false → true we re-issue `terminals.create({focusTabName})`
   * to drag the Zellij client back onto the right tab — covers the cases
   * where the user wandered off via Ctrl+t in xterm or where the toggle
   * leaves us looking at whichever tab was last focused.
   *
   * Defaults to true; pass `visible={false}` when the parent is hiding the
   * terminal so the refocus fires when you flip it back.
   */
  visible?: boolean;
}

export const EmbeddedTerminal: React.FC<EmbeddedTerminalProps> = ({
  client,
  userId,
  branchId,
  focusTabName,
  ensureCliSessionId,
  height = 480,
  fill = false,
  visible = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!client || !userId || !containerRef.current) return;

    let mounted = true;
    let currentChannel: string | null = null;
    const socket = client.io;

    const handleOutput = (payload: { userId: string; data: string }) => {
      if (payload.userId === userId && terminalRef.current) {
        terminalRef.current.write(payload.data);
      }
    };
    const handleExit = (payload: { userId: string; exitCode: number }) => {
      if (payload.userId === userId && terminalRef.current) {
        terminalRef.current.writeln(`\r\n\r\n[Terminal exited with code ${payload.exitCode}]`);
        setConnected(false);
      }
    };
    // Readiness is the authoritative connected signal: the executor confirmed
    // its PTY is spawned and attached. Flipping on this (not on the
    // terminals.create resolution) avoids the "connected but silently dead"
    // state after a reconnect or a post-spawn executor crash.
    const handleReady = (payload: { userId: string }) => {
      if (payload.userId !== userId) return;
      setConnected(true);
      setReconnecting(false);
      setError(null);
    };
    const handleReadyError = (payload: { userId: string; message?: string }) => {
      if (payload.userId !== userId) return;
      setError(payload.message || 'Terminal failed to start');
      setConnected(false);
      setReconnecting(false);
    };

    const terminal = new Terminal({
      allowProposedApi: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: true,
      scrollback: 1000,
      rows: 24,
      cols: 80,
      theme: {
        background: '#141414',
        foreground: '#ffffff',
        cursor: '#2e9a92',
        cursorAccent: '#141414',
      },
    });
    terminal.open(containerRef.current);
    terminal.loadAddon(new ClipboardAddon());
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer');
      })
    );
    // GPU renderer first (falls back to DOM if WebGL is unavailable), then
    // the fit addon derives cols/rows from the container size.
    loadWebglRenderer(terminal);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;

    // @xterm/addon-fit measures the container and resizes the terminal to
    // match; the `onResize` handler below relays the new dims to the PTY.
    const fitToContainer = () => {
      if (!containerRef.current) return;
      const box = containerRef.current.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      try {
        fitAddon.fit();
      } catch {
        /* xterm refuses absurd sizes; ignore */
      }
    };

    // Fit once after the first paint (container has real dimensions), then
    // on every container size change. Menlo/Monaco can arrive late and shift
    // cell metrics, so re-fit when web fonts settle too.
    requestAnimationFrame(fitToContainer);
    if (typeof document !== 'undefined' && 'fonts' in document) {
      (document as unknown as { fonts: { ready: Promise<void> } }).fonts.ready
        .then(() => fitToContainer())
        .catch(() => {
          /* ignore */
        });
    }

    const ro = new ResizeObserver(() => fitToContainer());
    ro.observe(containerRef.current);

    // Register channel + input listeners once. They persist across socket
    // reconnects (only the server-side room join is lost — see handleReconnect).
    socket.on('terminal:output', handleOutput);
    socket.on('terminal:exit', handleExit);
    socket.on('terminal:ready', handleReady);
    socket.on('terminal:error', handleReadyError);

    terminal.onData((data) => {
      socket.emit('terminal:input', { userId, input: data });
    });
    terminal.onResize(({ cols, rows }) => {
      socket.emit('terminal:resize', { userId, cols, rows });
    });

    // Monotonic attach generation. Each (re)attach bumps it; a disconnect
    // bumps it too. An attach only applies its result if it's still the
    // current generation and the socket is still connected — otherwise a stale
    // pre-disconnect attach could resolve late and wrongly flip the UI back to
    // "connected", or out-of-order responses across flaps could clobber state.
    let attachGeneration = 0;

    const attach = async () => {
      const generation = ++attachGeneration;
      try {
        // The daemon-side terminals.create handles the tab-focus emit when
        // `focusTabName` is supplied — browser sockets are NOT allowed to
        // emit `terminal:tab` directly (rejected by the daemon's gateway
        // guard). It is idempotent, so re-issuing it on reconnect is safe.
        const result = (await client.service('terminals').create({
          rows: terminal.rows,
          cols: terminal.cols,
          branchId,
          focusTabName,
          ensureCliSessionId,
        })) as {
          userId: UserID;
          channel: string;
          sessionName: string;
          isNew: boolean;
          ready?: boolean;
        };
        // Drop a stale/superseded attach: another (re)connect started after
        // this call, or the socket dropped while it was in flight.
        if (!mounted || generation !== attachGeneration || !socket.connected) return;

        currentChannel = result.channel;
        socket.emit('join', result.channel);
        // Kick a resize to trigger a Zellij full redraw once (re)joined.
        socket.emit('terminal:resize', {
          userId,
          cols: terminal.cols,
          rows: terminal.rows,
        });

        // Warm path: the executor is already attached, so the response says
        // it's ready and we connect right away. Cold path: stay in the
        // connecting state until the executor's `terminal:ready` ack arrives.
        if (result.ready) {
          setConnected(true);
          setReconnecting(false);
          setError(null);
        }
      } catch (err) {
        if (!mounted || generation !== attachGeneration) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setReconnecting(false);
        if (terminalRef.current) {
          terminalRef.current.writeln('\r\n[Failed to attach to terminal]');
          terminalRef.current.writeln(`[Error: ${msg}]`);
        }
      }
    };

    // The socket auto-reconnects after a network blip or daemon restart, but
    // the server-side room membership and (possibly) the executor are gone.
    // Re-join + re-issue create on every (re)connect; surface a visible
    // "reconnecting" state rather than silently doing nothing.
    const handleReconnect = () => {
      setReconnecting(true);
      setConnected(false);
      void attach();
    };
    const handleDisconnect = () => {
      // Invalidate any in-flight attach so a late resolve can't flip us back
      // to connected while we're actually down.
      attachGeneration++;
      setConnected(false);
      setReconnecting(true);
    };
    socket.on('connect', handleReconnect);
    socket.on('disconnect', handleDisconnect);

    void attach();

    return () => {
      mounted = false;
      ro.disconnect();
      if (terminalRef.current) {
        // Disposing the terminal also disposes its loaded addons.
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      if (socket) {
        socket.off('terminal:output', handleOutput);
        socket.off('terminal:exit', handleExit);
        socket.off('terminal:ready', handleReady);
        socket.off('terminal:error', handleReadyError);
        socket.off('connect', handleReconnect);
        socket.off('disconnect', handleDisconnect);
        if (currentChannel) {
          socket.emit('leave', currentChannel);
        }
      }
      setConnected(false);
      setReconnecting(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId, branchId, focusTabName, ensureCliSessionId]);

  /**
   * Refocus tab when the embedded view becomes visible. Two cases:
   *
   *   - User toggles Agor → CLI: we want Zellij to land on `focusTabName`,
   *     not whatever tab they were last on (which could be `test-branch`
   *     or a sibling session's tab).
   *   - User used Ctrl+t inside the xterm to switch tabs and now we want
   *     them back on the right one when they switch views.
   *
   * We refire `terminals.create` (which is idempotent — when the executor
   * is already running it just emits a fresh `terminal:tab focus`
   * server-side). Browsers can't emit `terminal:tab` directly (gateway
   * guard), so this is the cheapest path.
   */
  useEffect(() => {
    if (!visible || !client || !userId || !focusTabName) return;
    let cancelled = false;
    (async () => {
      try {
        await client.service('terminals').create({
          rows: terminalRef.current?.rows ?? 30,
          cols: terminalRef.current?.cols ?? 140,
          branchId,
          focusTabName,
          ensureCliSessionId,
        });
      } catch (err) {
        if (cancelled) return;
        // Non-fatal — the existing focus from initial mount usually wins.
        console.warn('[EmbeddedTerminal] refocus failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, client, userId, branchId, focusTabName, ensureCliSessionId]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: '#000',
        padding: 8,
        borderRadius: 4,
        ...(fill ? { flex: 1, minHeight: 0, height: '100%' } : { minHeight: height }),
      }}
    >
      <div
        ref={containerRef}
        style={fill ? { flex: 1, minHeight: 0 } : { flex: 1, minHeight: height - 24 }}
      />
      {error ? (
        <Badge status="error" text={`Terminal error: ${error}`} style={{ padding: 4 }} />
      ) : reconnecting ? (
        <Badge status="warning" text="Reconnecting…" style={{ padding: 4 }} />
      ) : !connected ? (
        <Badge status="processing" text="Connecting to terminal…" style={{ padding: 4 }} />
      ) : null}
    </div>
  );
};
