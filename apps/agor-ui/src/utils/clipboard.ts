/**
 * Clipboard utilities
 *
 * Core clipboard primitive with async Clipboard API + a robust legacy
 * fallback. Used by all clipboard functionality in the app:
 * - `useCopyToClipboard()` hook — for buttons needing a "copied" icon state
 * - `CopyableContent` component — for hoverable content blocks
 * - Direct callers — for simple copy-on-click with toast feedback
 * - `clipboard-polyfill` — bridges `navigator.clipboard.writeText`/`write` on
 *   insecure origins (HTTP / LAN IPs) so third-party libs (e.g. Streamdown)
 *   that call the native API keep working.
 */

import React from 'react';

/**
 * Copy text (and optionally an HTML representation) to the clipboard using the
 * legacy `execCommand('copy')` path.
 *
 * We intercept the synthetic `copy` event and call `clipboardData.setData`
 * ourselves rather than relying on the browser copying a hidden textarea's
 * selection. This is the approach Ant Design and clipboard.js use: it is far
 * more reliable on non-secure origins, where a detached/off-screen textarea's
 * selection is sometimes reported as copied (execCommand returns `true`)
 * without anything actually reaching the clipboard. A temporary selected
 * textarea is still mounted because some browsers only fire `copy` when there
 * is an active selection.
 *
 * @returns true only if the copy event carried our data and execCommand ran
 */
export function legacyCopy(text: string, html?: string): boolean {
  if (typeof document === 'undefined') return false;

  const activeElement = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const savedRanges: Range[] = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i))
    : [];

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  // Keep it visually inert but still selectable (display:none / visibility:hidden
  // would make the selection — and thus the copy — a no-op).
  textarea.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let copied = false;
  const onCopy = (event: ClipboardEvent) => {
    event.preventDefault();
    if (event.clipboardData) {
      event.clipboardData.setData('text/plain', text);
      if (html) event.clipboardData.setData('text/html', html);
      copied = true;
    }
  };

  document.addEventListener('copy', onCopy, true);
  try {
    // `copied` is set by our handler; keep execCommand's result as a fallback
    // signal for browsers that copy the selection without exposing clipboardData.
    copied = document.execCommand('copy') || copied;
  } catch {
    copied = false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
    textarea.remove();
    // Restore whatever the user had selected/focused before we hijacked it.
    if (selection) {
      selection.removeAllRanges();
      for (const range of savedRanges) selection.addRange(range);
    }
    activeElement?.focus?.({ preventScroll: true });
  }

  return copied;
}

/**
 * Copy text to clipboard with the async Clipboard API + legacy fallback.
 *
 * @returns true if copy succeeded, false otherwise
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // The async Clipboard API only works in secure contexts. On HTTP / local
  // network IPs `navigator.clipboard` is absent (or its writeText rejects), and
  // awaiting that rejection first can consume the click's transient user
  // activation and break the legacy fallback too — so skip straight to it.
  if (globalThis.isSecureContext !== false && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path (e.g. cross-origin iframe without
      // clipboard-write permission).
    }
  }

  return legacyCopy(text);
}

/**
 * React hook for managing copy-to-clipboard state
 *
 * Returns a tuple of [copied, copyFn] where:
 * - copied: boolean indicating if text was recently copied
 * - copyFn: function to copy text (automatically resets copied state after delay)
 *
 * @param resetDelay - Delay in ms before resetting copied state (default: 2000)
 */
export function useCopyToClipboard(
  resetDelay = 2000
): [boolean, (text: string) => Promise<boolean>] {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = async (text: string): Promise<boolean> => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    const success = await copyToClipboard(text);

    if (success) {
      setCopied(true);
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, resetDelay);
    }

    return success;
  };

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return [copied, copy];
}
