import type { StickToBottomState, useStickToBottom } from 'use-stick-to-bottom';

/*
 * The places ConversationView relies on use-stick-to-bottom's mutable state
 * beyond its documented API, kept together so an upgrade has one place to
 * check. Written against use-stick-to-bottom 1.1.6 (pinned by pnpm-lock.yaml).
 * TranscriptWindow.browser.test.tsx (jump to bottom, wheel return, switching
 * back, parked trimming) is the upgrade gate.
 */

type ScrollToBottom = ReturnType<typeof useStickToBottom>['scrollToBottom'];

/**
 * Whether the bottom lock is engaged right now. Reads the live state: the
 * rendered escapedFromLock follows only a manual scroll, never a programmatic
 * jump (the library ignores its own scroll events).
 */
export function isBottomLockEngaged(state: StickToBottomState): boolean {
  return state.isAtBottom && !state.escapedFromLock;
}

/**
 * Calls back if the lock is engaged once the hook has settled a scroll;
 * returns a cancel. The hook engages its lock in a 1ms timeout after the
 * scroll event, so call this from a scroll listener registered after the
 * hook's: its timeout of the same delay then runs after the hook's.
 */
export function afterScrollSettles(state: StickToBottomState, callback: () => void): () => void {
  const timer = setTimeout(() => {
    if (isBottomLockEngaged(state)) callback();
  }, 1);
  return () => clearTimeout(timer);
}

/**
 * A newly attached scroll container (reopening a session renders a spinner
 * first) starts a fresh scroll baseline, as on first mount. Otherwise the hook
 * compares the old container's last position with this one's first scroll,
 * reads an upward scroll, and releases the bottom lock.
 */
export function resetScrollBaseline(state: StickToBottomState): void {
  state.lastScrollTop = undefined;
  state.ignoreScrollToTop = undefined;
}

/**
 * An explicit return to the bottom (jump button, send, panel activation).
 * scrollToBottom() sets isAtBottom but never clears the escape, so a prior
 * scroll-up would leave the lock half-engaged and the re-pin after late or
 * streamed content would not follow. It also scrolls a frame later while
 * isAtBottom flips now, so land first, synchronously, through the library's
 * own scrollTop setter (which bypasses CSS smooth scrolling and records the
 * position as programmatic). A trim triggered by the flip then anchors at the
 * bottom instead of mid-jump. `initial`/`resize` options do not apply to this
 * explicit call, so ask for `instant`: animated, it springs through history.
 *
 * Known gap (#3000): only an upward wheel escapes the lock synchronously (the
 * hook's own handling). Keyboard or scrollbar input in the same frame as the
 * jump can still be overridden by its pending instant scroll.
 */
export function jumpToBottom(state: StickToBottomState, scrollToBottom: ScrollToBottom): void {
  state.escapedFromLock = false;
  state.scrollTop = state.calculatedTargetScrollTop;
  void scrollToBottom({ animation: 'instant' });
}
