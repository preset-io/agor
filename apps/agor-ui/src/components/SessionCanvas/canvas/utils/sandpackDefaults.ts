/**
 * Prepend a body margin reset to Sandpack files.
 * The default React template imports /styles.css, so prepending to it
 * is the most reliable way to remove the browser's default body margin.
 * If /styles.css doesn't exist, adds one (the default template auto-imports it).
 */
export function withBodyReset(files: Record<string, string>): Record<string, string> {
  const reset = 'body{margin:0}';
  const key = '/styles.css';
  const existing = files[key];
  if (existing?.includes(reset)) return files;
  return { ...files, [key]: existing ? `${reset}\n${existing}` : reset };
}
