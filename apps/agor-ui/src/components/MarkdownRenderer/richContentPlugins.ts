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
  renderers: [{ language: 'vega-lite', component: VegaLiteRendererGate }],
};

export const streamdownRemarkPlugins: NonNullable<StreamdownProps['remarkPlugins']> = [
  ...Object.values(defaultRemarkPlugins),
  [remarkAlert, { tagName: 'blockquote' }],
];
