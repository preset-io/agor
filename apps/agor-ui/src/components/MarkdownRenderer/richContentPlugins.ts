import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import remarkAlert from 'remark-github-blockquote-alert';
import { defaultRemarkPlugins, type PluginConfig, type StreamdownProps } from 'streamdown';
import { VegaLiteRendererGate } from './VegaLiteRendererGate';

export const streamdownRichContentPlugins: PluginConfig = {
  cjk,
  code,
  math,
  mermaid,
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
