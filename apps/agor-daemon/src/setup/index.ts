/**
 * Setup Module
 *
 * Functions for daemon initialization extracted from index.ts.
 * Phase 1: Pure functions with no app dependencies (version, cors, credentials)
 * Phase 2: Configuration builders (swagger, socketio, database)
 */

// Phase 1: Pure functions
export { type BuildInfo, isDevSha, loadBuildInfo } from './build-info.js';
export {
  buildCorsConfig,
  type CorsConfigOptions,
  type CorsConfigResult,
  type CorsOrigin,
} from './cors.js';
export {
  type CredentialsConfig,
  type InitializedCredentials,
  initializeAnthropicApiKey,
  initializeAnthropicAuthToken,
  initializeAnthropicBaseUrl,
  initializeCredentials,
  initializeGeminiApiKey,
} from './credentials.js';
export { type DatabaseInitResult, initializeDatabase } from './database.js';
export {
  configureChannels,
  createSocketIOConfig,
  type SocketIOOptions,
  type SocketIOResult,
} from './socketio.js';
// Phase 2: Configuration builders
export { configureSwagger, type SwaggerOptions } from './swagger.js';
export { loadDaemonVersion } from './version.js';
