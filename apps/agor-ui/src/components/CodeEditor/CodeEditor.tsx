/**
 * Lazy-loaded wrapper around the CodeMirror-backed editor.
 *
 * The actual CM6 code (@uiw/react-codemirror + language/theme packages, ~150KB
 * gzipped) lives in `CodeEditor.inner.tsx` and is pulled in via React.lazy so
 * Vite code-splits it into its own chunk. The first render of any `<CodeEditor>`
 * triggers the async import; subsequent renders are synchronous.
 *
 * The fallback is an AntD `Input.TextArea` with the current value so the layout
 * doesn't jump while the CM6 chunk downloads.
 */
import { Input, theme } from 'antd';
import type React from 'react';
import { lazy, Suspense } from 'react';
import type { CodeEditorInnerProps, CodeEditorLanguage } from './CodeEditor.inner';

export type { CodeEditorLanguage };
export type CodeEditorProps = CodeEditorInnerProps;

const PlainTextEditor: React.FC<CodeEditorProps> = ({
  value,
  onChange,
  readOnly = false,
  placeholder,
  rows = 14,
  height,
  minHeight,
  maxHeight,
}) => {
  const { token } = theme.useToken();

  return (
    <Input.TextArea
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      readOnly={readOnly}
      placeholder={placeholder}
      rows={rows}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        fontFamily: token.fontFamilyCode,
        fontSize: token.fontSizeSM,
        height,
        minHeight: minHeight ?? `${rows * 20}px`,
        maxHeight,
        padding: token.paddingXS,
        margin: 0,
        overflow: 'auto',
        resize: maxHeight ? 'none' : 'vertical',
      }}
    />
  );
};

const CodeEditorInner = lazy(async () => {
  try {
    return await import('./CodeEditor.inner');
  } catch (error) {
    console.error('Failed to load CodeMirror editor; falling back to plain text editor.', error);
    return { default: PlainTextEditor };
  }
});

export const CodeEditor: React.FC<CodeEditorProps> = (props) => (
  <Suspense fallback={<PlainTextEditor {...props} readOnly />}>
    <CodeEditorInner {...props} />
  </Suspense>
);
