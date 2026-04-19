/**
 * Browser-safe re-export of `js-yaml`.
 *
 * Centralizes the YAML dependency in `@agor/core` so downstream packages
 * (including the UI bundle) can import `load` / `dump` without each one
 * taking a direct dep on `js-yaml`.
 *
 * `js-yaml` itself has no Node-only imports, so this module is safe to use
 * from the browser.
 */

import yaml from 'js-yaml';

export const load = yaml.load;
export const dump = yaml.dump;
export const YAMLException = yaml.YAMLException;

export type { DumpOptions, LoadOptions } from 'js-yaml';

export default yaml;
