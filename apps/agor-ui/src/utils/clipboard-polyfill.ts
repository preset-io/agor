/**
 * Clipboard API polyfill for non-HTTPS environments
 *
 * On insecure origins (HTTP / local network IPs) `navigator.clipboard` is
 * absent, so any code calling the native API fails — including third-party
 * libraries we don't control. Streamdown, for example, copies tables with
 * `navigator.clipboard.write([ClipboardItem])` (rich text/html + text/plain)
 * and code blocks with `navigator.clipboard.writeText`; without a polyfill its
 * copy silently no-ops and its dropdowns stay open.
 *
 * We back both `writeText` and `write` with the shared `legacyCopy`
 * (execCommand) primitive so those paths keep working off HTTPS.
 */

import { legacyCopy } from './clipboard';

/**
 * Minimal `ClipboardItem` shim. On insecure origins the global constructor is
 * undefined, so libraries that build `new ClipboardItem({...})` for
 * `clipboard.write` (e.g. Streamdown's table copy) throw a ReferenceError
 * before any copy is attempted. This stores the type→data map and exposes the
 * spec surface our `write` polyfill reads back.
 */
class ClipboardItemShim {
  private readonly data: Record<string, Blob | string | Promise<Blob | string>>;

  constructor(items: Record<string, Blob | string | Promise<Blob | string>>) {
    this.data = items;
  }

  get types(): string[] {
    return Object.keys(this.data);
  }

  async getType(type: string): Promise<Blob> {
    const value = await this.data[type];
    if (value instanceof Blob) return value;
    return new Blob([String(value ?? '')], { type });
  }
}

/** Read text/plain (+ text/html) out of the items passed to `clipboard.write`. */
async function extractClipboardItems(
  items: ClipboardItems
): Promise<{ text: string; html?: string }> {
  let text = '';
  let html: string | undefined;
  for (const item of items) {
    if (!item?.types) continue;
    if (item.types.includes('text/plain')) {
      try {
        text = await (await item.getType('text/plain')).text();
      } catch {
        // ignore unreadable item
      }
    }
    if (item.types.includes('text/html')) {
      try {
        html = await (await item.getType('text/html')).text();
      } catch {
        // ignore unreadable item
      }
    }
  }
  return { text, html };
}

function writeText(text: string): Promise<void> {
  return legacyCopy(String(text)) ? Promise.resolve() : Promise.reject(new Error('Copy failed'));
}

async function write(items: ClipboardItems): Promise<void> {
  // In-memory Blobs resolve on a microtask, so user activation survives the
  // awaits and the execCommand copy below still counts as user-initiated.
  const { text, html } = await extractClipboardItems(items);
  if (!legacyCopy(text, html)) throw new Error('Copy failed');
}

/**
 * Install a clipboard polyfill when the native async API (or a needed method)
 * is unavailable — typically because the page is served over plain HTTP.
 * Call this early in app initialization (e.g., main.tsx).
 *
 * Only missing methods are filled in; native implementations (secure contexts)
 * are left untouched.
 */
export function installClipboardPolyfill(): void {
  // `clipboard.write` callers construct `new ClipboardItem(...)`; provide the
  // global on insecure origins where it's absent, independent of the clipboard
  // object below (so the constructor never throws before write() runs).
  if (typeof (globalThis as { ClipboardItem?: unknown }).ClipboardItem === 'undefined') {
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = ClipboardItemShim;
  }

  // Typed as Partial because on insecure origins these methods are genuinely
  // absent at runtime even though the DOM lib types them as always-present.
  const existing = navigator.clipboard as Partial<Clipboard> | undefined;

  // Secure contexts expose a complete native clipboard — leave it alone.
  if (existing?.writeText && existing.write) return;

  const polyfilled = {
    writeText: existing?.writeText?.bind(existing) ?? writeText,
    write: existing?.write?.bind(existing) ?? write,
    readText:
      existing?.readText?.bind(existing) ??
      (() => Promise.reject(new Error('Reading clipboard not supported'))),
    read:
      existing?.read?.bind(existing) ??
      (() => Promise.reject(new Error('Reading clipboard not supported'))),
  };

  Object.defineProperty(navigator, 'clipboard', {
    value: polyfilled,
    writable: false,
    configurable: true,
  });
}
