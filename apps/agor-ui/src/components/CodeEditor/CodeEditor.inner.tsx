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
import { useEffect, useMemo, useState } from 'react';
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

const LANGUAGE_EXTENSIONS: Partial<Record<CodeEditorLanguage, LanguageExtensionFactory>> = {
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
  height,
  minHeight,
  maxHeight,
}) => {
  // `isDark` is the canonical dark/light signal from ThemeContext — already
  // accounts for `themeMode === 'custom'` rendering dark.
  const { isDark } = useTheme();
  const [markdownExtensionFactory, setMarkdownExtensionFactory] =
    useState<LanguageExtensionFactory | null>(null);

  useEffect(() => {
    if (language !== 'markdown' || markdownExtensionFactory) return;

    let cancelled = false;
    import('@codemirror/lang-markdown')
      .then(({ markdown }) => {
        const createMarkdownWithCodeLanguages = () =>
          markdown({
            codeLanguages: (info) => {
              const languageName = info.trim().split(/\s+/, 1)[0]?.toLowerCase();
              if (languageName === 'yaml' || languageName === 'yml') return yaml().language;
              if (languageName === 'json') return json().language;
              return null;
            },
          });
        if (!cancelled) {
          setMarkdownExtensionFactory(
            () => createMarkdownWithCodeLanguages as LanguageExtensionFactory
          );
        }
      })
      .catch((error) => {
        console.error('Failed to load CodeMirror markdown highlighting.', error);
      });

    return () => {
      cancelled = true;
    };
  }, [language, markdownExtensionFactory]);

  const extensions = useMemo(() => {
    const extensionFactory =
      language === 'markdown' ? markdownExtensionFactory : LANGUAGE_EXTENSIONS[language];
    return extensionFactory ? [extensionFactory()] : [];
  }, [language, markdownExtensionFactory]);

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
