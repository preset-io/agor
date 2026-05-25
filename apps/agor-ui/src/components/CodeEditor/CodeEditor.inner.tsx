/**
 * Inner CodeMirror 6 editor component.
 *
 * This file is the lazy-load target — it pulls in @uiw/react-codemirror and
 * its CM6 language/theme extensions. Do NOT import it directly from app code;
 * import `CodeEditor` from `./index` instead, which wraps this in React.lazy.
 *
 * Split out into its own module so Vite can code-split the ~150KB of CM6
 * into its own chunk that only loads when an editor is actually rendered.
 */
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';
import CodeMirror from '@uiw/react-codemirror';
import type React from 'react';
import { useMemo } from 'react';
import { useTheme } from '../../contexts/ThemeContext';

export type CodeEditorLanguage = 'json' | 'yaml';

export interface CodeEditorInnerProps {
  value: string;
  onChange?: (value: string) => void;
  language: CodeEditorLanguage;
  readOnly?: boolean;
  placeholder?: string;
  /** Approximate visible height in editor rows (~20px each). */
  rows?: number;
  minHeight?: string;
  maxHeight?: string;
}

// Factory shape shared by CM6 `@codemirror/lang-*` packages: each exports a
// zero-arg constructor returning an Extension. Inferring the type from `json`
// avoids taking a direct dep on `@codemirror/state` (which is transitive).
type LanguageExtensionFactory = typeof json;

const LANGUAGE_EXTENSIONS: Record<CodeEditorLanguage, LanguageExtensionFactory> = {
  json,
  yaml,
};

const CodeEditorInner: React.FC<CodeEditorInnerProps> = ({
  value,
  onChange,
  language,
  readOnly = false,
  placeholder,
  rows = 14,
  minHeight,
  maxHeight,
}) => {
  // `isDark` is the canonical dark/light signal from ThemeContext — already
  // accounts for `themeMode === 'custom'` rendering dark.
  const { isDark } = useTheme();

  const extensions = useMemo(() => [LANGUAGE_EXTENSIONS[language]()], [language]);

  // ~20px per row is a close-enough match to Ant's TextArea sizing so editors
  // don't jump visibly when call sites migrate from `rows={14}` textareas.
  const computedMinHeight = minHeight ?? `${rows * 20}px`;

  return (
    <CodeMirror
      value={value}
      onChange={(v) => onChange?.(v)}
      extensions={extensions}
      theme={isDark ? oneDark : undefined}
      readOnly={readOnly}
      placeholder={placeholder}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
      }}
      style={{
        fontSize: 12,
        border: '1px solid var(--ant-color-border, #424242)',
        borderRadius: 6,
        overflow: 'hidden',
      }}
      minHeight={computedMinHeight}
      maxHeight={maxHeight}
    />
  );
};

export default CodeEditorInner;
