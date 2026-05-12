/**
 * Agor Configuration Module
 *
 * Exports configuration management, repo reference parsing utilities.
 */

export * from './agor-yml';
export * from './config-manager';
export * from './constants';
export * from './env-blocklist';
export * from './env-locking';
export * from './env-resolver';
export * from './env-validation';
export * from './env-vars';
export * from './key-resolver';
export type { ProxyMethod, ResolvedProxy } from './proxies-resolver';
export { resolveProxies } from './proxies-resolver';
export * from './repo-list';
export * from './repo-reference';
export * from './resource-schemas';
export * from './resource-sync';
export type {
  AgorGitConfigParametersSettings,
  ResolvedCors,
  ResolvedCsp,
  ResolvedSecurity,
  ResolveSecurityOptions,
} from './security-resolver';
export {
  getDefaultGitConfigParameters,
  gitConfigParameterLooksSecret,
  redactUrlUserinfo,
  renderGitConfigParametersForLog,
  resolveGitConfigParameters,
  resolveSecurity,
  SANDPACK_CSP_FRAME_SRC,
  SANDPACK_CSP_WORKER_SRC,
} from './security-resolver';
export * from './types';
