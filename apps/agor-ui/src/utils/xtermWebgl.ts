import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

/**
 * Load xterm's GPU-accelerated WebGL renderer, wired with the addon's
 * documented context-loss fallback.
 *
 * xterm's default DOM renderer is slow for full-screen repaints (zellij
 * redraws, verbose builds); the WebGL renderer offloads glyph rasterization
 * to the GPU. Two failure modes are handled here:
 *
 *   - No WebGL at all (headless CI, software-GL, locked-down browsers): the
 *     addon throws on `activate`. We swallow it and leave the terminal on its
 *     DOM renderer.
 *   - Context loss after a successful load (GPU reset, backgrounded tab): the
 *     addon emits `onContextLoss`; disposing it hands rendering back to the
 *     DOM renderer instead of leaving a frozen canvas.
 *
 * The terminal must already be `open()`ed before calling this — the renderer
 * needs the attached DOM node to create its GL context.
 */
export function loadWebglRenderer(terminal: Terminal): WebglAddon | null {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    terminal.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
}
