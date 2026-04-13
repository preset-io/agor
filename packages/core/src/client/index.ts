/**
 * Client-safe @agor/core surface for browser/SDK consumers.
 *
 * This entrypoint must stay free of Node-only SDK/runtime imports.
 */

export type {
  AgorClient,
  AgorService,
  BoardsService,
  MessagesService,
  ReposLocalService,
  ReposService,
  ServiceTypes,
  SessionPromptOptions,
  SessionPromptResult,
  SessionsService,
  TasksService,
  WorktreesService,
} from '../api/index.js';
export {
  createClient,
  createRestClient,
  getApiKeyFromEnv,
  isDaemonRunning,
} from '../api/index.js';

export * from '../config/browser.js';
export type { AgorConfig } from '../config/types.js';
export * from '../templates/handlebars-helpers.js';
export * from '../types/index.js';
