import { message } from 'antd';

/**
 * Copy text to clipboard with error handling
 *
 * @param text - Text to copy to clipboard
 * @param options - Optional configuration
 * @param options.showSuccess - Whether to show success message (default: false)
 * @param options.successMessage - Custom success message
 * @param options.showError - Whether to show error message (default: true)
 * @param options.errorMessage - Custom error message
 * @returns Promise that resolves to true if successful, false otherwise
 */
export async function copyToClipboard(
  text: string,
  options?: {
    showSuccess?: boolean;
    successMessage?: string;
    showError?: boolean;
    errorMessage?: string;
  }
): Promise<boolean> {
  const {
    showSuccess = false,
    successMessage = 'Copied to clipboard',
    showError = true,
    errorMessage = 'Failed to copy to clipboard',
  } = options || {};

  try {
    // Try modern Clipboard API first (requires HTTPS)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      if (showSuccess) {
        message.success(successMessage);
      }
      return true;
    }

    // Fallback to execCommand for HTTP/dev mode
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
      if (showSuccess) {
        message.success(successMessage);
      }
      return true;
    } else {
      throw new Error('execCommand copy failed');
    }
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    if (showError) {
      message.error(errorMessage);
    }
    return false;
  }
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
): [boolean, (text: string, showFeedback?: boolean) => Promise<boolean>] {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<NodeJS.Timeout>();

  const copy = async (text: string, showFeedback = false): Promise<boolean> => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    const success = await copyToClipboard(text, {
      showSuccess: showFeedback,
      showError: showFeedback,
    });

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

// Import React for the hook
import React from 'react';
