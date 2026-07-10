/**
 * Inner CodeMirror 6 editor component.
 *
 * This file is the lazy-load target — it pulls in @uiw/react-codemirror and
 * its CM6 language/theme extensions. Do NOT import it directly from app code;
 * import `CodeEditor` from `./index` instead, which wraps this in React.lazy.
 *
 * Split out into its own module so Vite can code-split the ~150KB of CM6
 * into its own chunk that only loads when an editor is actually rendered.
 *
 * All language packages are imported statically so they land in the same
 * async chunk as @codemirror/state. A nested dynamic import() would create a
 * second async chunk boundary that causes Rollup to duplicate @codemirror/state
 * across chunks, breaking its instanceof checks at runtime.
 */
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';
import CodeMirror from '@uiw/react-codemirror';
import type React from 'react';
import { useMemo } from 'react';
import { useTheme } from '../../contexts/ThemeContext';

export type CodeEditorLanguage = 'json' | 'yaml' | 'markdown';

export interface CodeEditorInnerProps {
  value: string;
  onChange?: (value: string) => void;
  language: CodeEditorLanguage;
  readOnly?: boolean;
  placeholder?: string;
  /** Approximate visible height in editor rows (~20px each). */
  rows?: number;
  height?: string;
  minHeight?: string;
  maxHeight?: string;
}

// Factory shape shared by CM6 `@codemirror/lang-*` packages: each exports a
// zero-arg constructor returning an Extension. Inferring the type from `json`
// avoids taking a direct dep on `@codemirror/state` (which is transitive).
type LanguageExtensionFactory = typeof json;

// Markdown is configured with codeLanguages so fenced code blocks get
// syntax highlighting for yaml/json. Wrapped in a factory to match the
// shape of the other entries and to defer the extension object creation
// until the editor first renders.
const markdownWithCodeLanguages: LanguageExtensionFactory = () =>
  markdown({
    codeLanguages: (info) => {
      const languageName = info.trim().split(/\s+/, 1)[0]?.toLowerCase();
      if (languageName === 'yaml' || languageName === 'yml') return yaml().language;
      if (languageName === 'json') return json().language;
      return null;
    },
  });

const LANGUAGE_EXTENSIONS: Partial<Record<CodeEditorLanguage, LanguageExtensionFactory>> = {
  json,
  yaml,
  markdown: markdownWithCodeLanguages,
};

const CodeEditorInner: React.FC<CodeEditorInnerProps> = ({
  value,
  onChange,
  language,
  readOnly = false,
  placeholder,
  rows = 14,
  height,
  minHeight,
  maxHeight,
}) => {
  // `isDark` is the canonical dark/light signal from ThemeContext — already
  // accounts for `themeMode === 'custom'` rendering dark.
  const { isDark } = useTheme();

  const extensions = useMemo(() => {
    const extensionFactory = LANGUAGE_EXTENSIONS[language];
    return extensionFactory ? [extensionFactory()] : [];
  }, [language]);

  // ~20px per row is a close-enough match to Ant's TextArea sizing so editors
  // don't jump visibly when call sites migrate from `rows={14}` textareas.
  const computedMinHeight = minHeight ?? `${rows * 20}px`;
  const fillHeight = Boolean(height);

  return (
    <>
      {fillHeight && (
        <style>
          {`
            .agor-code-editor-fill,
            .agor-code-editor-fill .cm-editor,
            .agor-code-editor-fill .cm-scroller {
              height: 100%;
            }
          `}
        </style>
      )}
      <CodeMirror
        className={fillHeight ? 'agor-code-editor-fill' : undefined}
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
        height={height}
        style={{
          height,
          fontSize: 12,
          border: '1px solid var(--ant-color-border, #424242)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
        minHeight={height ? undefined : computedMinHeight}
        maxHeight={height ? undefined : maxHeight}
      />
    </>
  );
};

export default CodeEditorInner;
