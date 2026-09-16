import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import remarkBreaks from 'remark-breaks';
import remarkAlert from 'remark-github-blockquote-alert';
import { defaultRemarkPlugins, type PluginConfig, type StreamdownProps } from 'streamdown';
import { VegaLiteRendererGate } from './VegaLiteRendererGate';

const math = createMathPlugin({ singleDollarTextMath: true });

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

// Chat input uses an Enter as an intentional line break. Transform only prose
// nodes, so fenced code, lists, and existing Markdown hard breaks stay intact.
export const streamdownUserMessageRemarkPlugins: NonNullable<StreamdownProps['remarkPlugins']> = [
  ...streamdownRemarkPlugins,
  remarkBreaks,
];
