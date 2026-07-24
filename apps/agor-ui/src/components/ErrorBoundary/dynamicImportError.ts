const DYNAMIC_IMPORT_LOAD_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /chunkloaderror/i,
  /loading chunk \S+ failed/i,
  /unable to preload css for/i,
];

/**
 * Browsers use different messages for network/asset failures from import().
 * Keep this deliberately narrow so module evaluation and component render
 * errors can use a different fallback from recoverable document-load errors.
 */
export function isDynamicImportLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return DYNAMIC_IMPORT_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
