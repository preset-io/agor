/**
 * Map a file path's extension to a Prism language id used by
 * `ThemedSyntaxHighlighter`. Returns `'text'` for unknown extensions so
 * the highlighter still renders (just without coloring).
 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  css: 'css',
  scss: 'scss',
  html: 'html',
  xml: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql',
  graphql: 'graphql',
  proto: 'protobuf',
  toml: 'toml',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  markdown: 'markdown',
  env: 'bash',
};

export function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return LANGUAGE_BY_EXT[ext ?? ''] ?? 'text';
}
