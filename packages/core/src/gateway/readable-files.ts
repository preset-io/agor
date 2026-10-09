/** Inbound attachment types the gateway hands to agents: images and text-like files. */
export const GATEWAY_READABLE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

const GATEWAY_READABLE_EXTENSIONS: ReadonlyArray<[RegExp, string]> = [
  [/\.png$/, 'image/png'],
  [/\.jpe?g$/, 'image/jpeg'],
  [/\.gif$/, 'image/gif'],
  [/\.webp$/, 'image/webp'],
  [/\.(txt|log)$/, 'text/plain'],
  [/\.(md|markdown)$/, 'text/markdown'],
  [/\.csv$/, 'text/csv'],
  [/\.json$/, 'application/json'],
];

/** The readable MIME type implied by a file name's extension, if any. */
export function readableMimeForFilename(filename: string): string | undefined {
  const lowerName = filename.toLowerCase();
  return GATEWAY_READABLE_EXTENSIONS.find(([pattern]) => pattern.test(lowerName))?.[1];
}
