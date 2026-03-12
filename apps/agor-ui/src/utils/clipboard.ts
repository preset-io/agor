/**
 * Clipboard utilities
 *
 * Core clipboard primitive with Clipboard API + execCommand fallback.
 * Used by all clipboard functionality in the app:
 * - `useCopyToClipboard()` hook — for buttons needing a "copied" icon state
 * - `CopyableContent` component — for hoverable content blocks
 * - Direct callers — for simple copy-on-click with toast feedback
 */

import React from 'react';

/**
 * Copy text to clipboard with Clipboard API + execCommand fallback.
 *
 * @returns true if copy succeeded, false otherwise
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Try modern Clipboard API first (requires HTTPS / secure context)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API exists but failed (e.g. non-secure context) — fall through to execCommand
    }
  }

  // Fallback to execCommand for HTTP/dev mode
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);

    if (successful) {
      return true;
    }
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
  }

  return false;
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
  const timeoutRef = React.useRef<NodeJS.Timeout>();

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
