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
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
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

    // xterm's internal DOM doesn't flex with the container — its
    // measurement is `cols × cellWidth` pixels, fixed at construction.
    // Without @xterm/addon-fit (which we don't have as a dep yet) we
    // implement fit manually: start with conservative bootstrap dims, let
    // xterm render once so it publishes real per-cell pixel sizes via
    // `_core._renderService.dimensions.css.cell`, then fit to the
    // parent's clientWidth/clientHeight. Re-fit on every container size
    // change via ResizeObserver. The xterm element itself is forced to
    // fill its container via the inline-style block below, so font/zoom
    // changes also trip the ResizeObserver and re-fit cleanly.
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
    terminalRef.current = terminal;

    // Force the xterm root + viewport to fill the container, so the
    // .xterm element grows when the pane grows. xterm's stylesheet
    // defaults to a fixed pixel size; we override here.
    const xtermEl = containerRef.current.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) {
      xtermEl.style.width = '100%';
      xtermEl.style.height = '100%';
    }

    const fitToContainer = () => {
      if (!terminalRef.current || !containerRef.current) return;
      // biome-ignore lint/suspicious/noExplicitAny: tap xterm internals for cell metrics
      const core = (terminalRef.current as any)._core;
      const cellW: number | undefined = core?._renderService?.dimensions?.css?.cell?.width;
      const cellH: number | undefined = core?._renderService?.dimensions?.css?.cell?.height;
      if (!cellW || !cellH || cellW <= 0 || cellH <= 0) return; // not rendered yet
      const box = containerRef.current.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const cols = Math.max(20, Math.floor(box.width / cellW));
      const rows = Math.max(5, Math.floor(box.height / cellH));
      if (cols !== terminalRef.current.cols || rows !== terminalRef.current.rows) {
        try {
          terminalRef.current.resize(cols, rows);
        } catch {
          /* xterm refuses absurd sizes; ignore */
        }
      }
    };

    // First fit fires once xterm paints (cell metrics become real).
    // We hit `fit` from multiple angles to defeat the layout-not-ready /
    // font-not-loaded / cell-metrics-not-published race:
    //
    //   1. `terminal.onRender` — xterm's per-frame paint signal.
    //   2. rAF nested rAF — catches the case where onRender already
    //      fired before the listener attached.
    //   3. ResizeObserver on the parent — catches container size changes
    //      (tab toggles, browser zoom, pane drags).
    //   4. A short setInterval burst for the first ~1.5s — covers
    //      `document.fonts.ready` and weird Vite HMR remount paths
    //      where cell metrics flip from default → real after paint.
    let renderHandlerOff: { dispose(): void } | null = null;
    try {
      renderHandlerOff = terminal.onRender(() => fitToContainer());
    } catch {
      /* xterm v5 onRender signature variations — fall back to rAF only */
    }
    requestAnimationFrame(() => {
      fitToContainer();
      requestAnimationFrame(fitToContainer);
    });
    // Burst fit for 1.5s so the terminal definitively reaches its
    // container size by the time the user is ready to read it.
    const fitBurst = setInterval(fitToContainer, 100);
    const fitBurstStop = setTimeout(() => clearInterval(fitBurst), 1500);
    // Also re-fit when web fonts finish loading — Menlo / Monaco may
    // arrive late and shift cellWidth.
    if (typeof document !== 'undefined' && 'fonts' in document) {
      (document as unknown as { fonts: { ready: Promise<void> } }).fonts.ready
        .then(() => fitToContainer())
        .catch(() => {
          /* ignore */
        });
    }

    const ro = new ResizeObserver(() => fitToContainer());
    ro.observe(containerRef.current);

    (async () => {
      try {
        // The daemon-side terminals.create handles the tab-focus emit when
        // `focusTabName` is supplied — browser sockets are NOT allowed to
        // emit `terminal:tab` directly (rejected by the daemon's gateway
        // guard).
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
        };
        if (!mounted) return;

        currentChannel = result.channel;
        socket.emit('join', result.channel);
        socket.on('terminal:output', handleOutput);
        socket.on('terminal:exit', handleExit);

        terminal.onData((data) => {
          socket.emit('terminal:input', { userId, input: data });
        });
        terminal.onResize(({ cols, rows }) => {
          socket.emit('terminal:resize', { userId, cols, rows });
        });
        // Kick a resize to trigger a Zellij full redraw.
        socket.emit('terminal:resize', {
          userId,
          cols: terminal.cols,
          rows: terminal.rows,
        });

        setConnected(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        if (terminalRef.current) {
          terminalRef.current.writeln('\r\n[Failed to attach to terminal]');
          terminalRef.current.writeln(`[Error: ${msg}]`);
        }
      }
    })();

    return () => {
      mounted = false;
      ro.disconnect();
      clearInterval(fitBurst);
      clearTimeout(fitBurstStop);
      try {
        renderHandlerOff?.dispose();
      } catch {
        /* already disposed */
      }
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      if (socket) {
        socket.off('terminal:output', handleOutput);
        socket.off('terminal:exit', handleExit);
        if (currentChannel) {
          socket.emit('leave', currentChannel);
        }
      }
      setConnected(false);
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
      {error && (
        <div style={{ color: '#ff7875', fontSize: 12, padding: 4 }}>Terminal error: {error}</div>
      )}
      {!connected && !error && (
        <div style={{ color: '#bfbfbf', fontSize: 12, padding: 4 }}>Connecting to terminal…</div>
      )}
    </div>
  );
};
