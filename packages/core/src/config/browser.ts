/**
 * Browser-Safe Config Utilities
 *
 * Re-exports only browser-compatible config utilities (no Node.js fs/path/os dependencies).
 * Use this module in browser environments instead of '@agor/core/config'.
 */

export * from './constants';
export * from './repo-list';
export * from './repo-reference';
export * from './types';
