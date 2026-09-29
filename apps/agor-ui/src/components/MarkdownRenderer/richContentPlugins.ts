import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { useEffect, useSyncExternalStore } from 'react';
import remarkAlert from 'remark-github-blockquote-alert';
import {
  type DiagramPlugin,
  defaultRemarkPlugins,
  type MathPlugin,
  type PluginConfig,
  type StreamdownProps,
} from 'streamdown';
import { VegaLiteRendererGate } from './VegaLiteRendererGate';

type MermaidConfig = Parameters<DiagramPlugin['getMermaid']>[0];

/**
 * `@streamdown/mermaid` statically imports Mermaid (~1 MB with its d3 and
 * layout dependencies), which would otherwise ship with every transcript and
 * board note. Streamdown only ever calls `getMermaid(config).render(...)`,
 * which is already async, so this stand-in loads the real plugin on the first
 * diagram render and forwards to it.
 */
export function createLazyMermaidPlugin(
  load: () => Promise<DiagramPlugin> = () =>
    import('@streamdown/mermaid').then((module) => module.mermaid)
): DiagramPlugin {
  let plugin: Promise<DiagramPlugin> | null = null;
  let config: MermaidConfig;
  let appliedConfig: MermaidConfig;
  const instance: ReturnType<DiagramPlugin['getMermaid']> = {
    initialize(next) {
      config = next;
    },
    async render(id, source) {
      plugin ??= load().catch((error) => {
        plugin = null;
        throw error;
      });
      const real = await plugin;
      // Re-initialize only when the requested config changed.
      const changed = config !== appliedConfig;
      appliedConfig = config;
      return real.getMermaid(changed ? config : undefined).render(id, source);
    },
  };
  return {
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid(next) {
      if (next) config = next;
      return instance;
    },
  };
}

// KaTeX (~450 KB) is only needed for `$$` math, and the math plugin has to be
// handed to Streamdown synchronously. So it is not part of the base set: a
// document that contains `$$` loads it on first sight and re-renders with it.
// (`singleDollarTextMath` is off, so a single `$` never starts math.)
let mathPlugin: MathPlugin | null = null;
let mathLoad: Promise<void> | null = null;
const mathListeners = new Set<() => void>();

export function markdownNeedsMath(markdown: string): boolean {
  return markdown.includes('$$');
}

export function loadMathPlugin(
  load: () => Promise<MathPlugin> = () => import('@streamdown/math').then((module) => module.math)
): Promise<void> {
  mathLoad ??= load().then(
    (plugin) => {
      mathPlugin = plugin;
      for (const listener of mathListeners) listener();
    },
    (error) => {
      mathLoad = null;
      throw error;
    }
  );
  return mathLoad;
}

function subscribeMathPlugin(listener: () => void): () => void {
  mathListeners.add(listener);
  return () => mathListeners.delete(listener);
}

/**
 * The math plugin for a document that `needed` it, once loaded (starting the
 * load). Documents without math always get null, so the load re-renders only
 * the documents that use it.
 */
export function useMathPlugin(needed: boolean): MathPlugin | null {
  const getSnapshot = () => (needed ? mathPlugin : null);
  const plugin = useSyncExternalStore(subscribeMathPlugin, getSnapshot, getSnapshot);
  useEffect(() => {
    if (needed && !plugin) loadMathPlugin().catch(() => {});
  }, [needed, plugin]);
  return plugin;
}

export function withMathPlugin(plugins: PluginConfig, math: MathPlugin | null): PluginConfig {
  return math ? { ...plugins, math } : plugins;
}

export const streamdownRichContentPlugins: PluginConfig = {
  cjk,
  code,
  mermaid: createLazyMermaidPlugin(),
};

/** Demo-only POC plugin set. Vega-Lite is intentionally default-off. */
export const streamdownRichContentPluginsWithVegaLite: PluginConfig = {
  ...streamdownRichContentPlugins,
  renderers: [{ language: 'vega-lite', component: VegaLiteRendererGate }],
};

export const streamdownRemarkPlugins: NonNullable<StreamdownProps['remarkPlugins']> = [
  ...Object.values(defaultRemarkPlugins),
  [remarkAlert, { tagName: 'blockquote' }],
];
