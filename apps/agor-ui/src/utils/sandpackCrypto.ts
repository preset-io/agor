/**
 * Sandpack uses crypto.subtle.digest() to generate short IDs. Plain HTTP
 * contexts do not expose WebCrypto subtle, so provide the same lightweight
 * non-cryptographic fallback everywhere Agor renders Sandpack artifacts.
 */
export function ensureSandpackCryptoSubtle(): void {
  if (typeof globalThis.crypto === 'undefined' || globalThis.crypto.subtle) return;

  // biome-ignore lint/suspicious/noExplicitAny: minimal polyfill for Sandpack compatibility
  (globalThis.crypto as any).subtle = {
    async digest(_algo: string, data: ArrayBuffer) {
      const bytes = new Uint8Array(data);
      let hash = 0;
      for (const b of bytes) hash = (hash * 31 + b) | 0;
      const result = new ArrayBuffer(4);
      new DataView(result).setInt32(0, hash);
      return result;
    },
  };
}
