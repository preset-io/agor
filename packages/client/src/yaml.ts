/**
 * Browser-safe YAML utilities — thin re-export of `@agor/core/yaml`.
 *
 * Exposed on `@agor-live/client` so UI/browser consumers can parse and emit
 * YAML without taking a direct dep on `js-yaml` (or on `@agor/core`).
 */

export * from '@agor/core/yaml';
export { default } from '@agor/core/yaml';
