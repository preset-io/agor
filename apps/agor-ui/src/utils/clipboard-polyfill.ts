/**
 * Clipboard API polyfill for non-HTTPS environments
 *
 * Uses execCommand fallback to ensure clipboard functionality works
 * on HTTP and local network IPs (where navigator.clipboard is unavailable)
 */

/**
 * Fallback copy using execCommand (works on HTTP)
 */
function execCommandCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);

      if (successful) {
        resolve();
      } else {
        reject(new Error('execCommand copy failed'));
      }
    } catch (err) {
      document.body.removeChild(textArea);
      reject(err);
    }
  });
}

/**
 * Install clipboard polyfill if navigator.clipboard is unavailable
 * Call this early in your app initialization (e.g., main.tsx)
 */
export function installClipboardPolyfill(): void {
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    // Polyfill navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: execCommandCopy,
        readText: () => Promise.reject(new Error('Reading clipboard not supported')),
      },
      writable: false,
      configurable: true,
    });
  }
}
