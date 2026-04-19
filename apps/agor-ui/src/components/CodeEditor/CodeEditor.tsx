/**
 * Lazy-loaded wrapper around the CodeMirror-backed editor.
 *
 * The actual CM6 code (@uiw/react-codemirror + language/theme packages, ~150KB
 * gzipped) lives in `CodeEditor.inner.tsx` and is pulled in via React.lazy so
 * Vite code-splits it into its own chunk. The first render of any `<CodeEditor>`
 * triggers the async import; subsequent renders are synchronous.
 *
 * The fallback is a monospace `<pre>` with the current value so the layout
 * doesn't jump while the CM6 chunk downloads.
 */
import type React from 'react';
import { lazy, Suspense } from 'react';
import type { CodeEditorInnerProps, CodeEditorLanguage } from './CodeEditor.inner';

const CodeEditorInner = lazy(() => import('./CodeEditor.inner'));

export type { CodeEditorLanguage };
export type CodeEditorProps = CodeEditorInnerProps;

const Fallback: React.FC<Pick<CodeEditorProps, 'value' | 'rows' | 'minHeight'>> = ({
  value,
  rows = 14,
  minHeight,
}) => (
  <pre
    style={{
      fontFamily: 'monospace',
      fontSize: 12,
      minHeight: minHeight ?? `${rows * 20}px`,
      padding: 8,
      margin: 0,
      border: '1px solid var(--ant-color-border, #424242)',
      borderRadius: 6,
      background: 'var(--ant-color-fill-alter, transparent)',
      whiteSpace: 'pre',
      overflow: 'auto',
    }}
  >
    {value}
  </pre>
);

export const CodeEditor: React.FC<CodeEditorProps> = (props) => (
  <Suspense fallback={<Fallback {...props} />}>
    <CodeEditorInner {...props} />
  </Suspense>
);
