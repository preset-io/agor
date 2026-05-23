/**
 * Client-safe @agor/core surface for browser/SDK consumers.
 *
 * This entrypoint must stay free of Node-only SDK/runtime imports AND of
 * Handlebars (which uses `new Function` and would force browsers to ship
 * with CSP `script-src 'unsafe-eval'`). Server-side renderers should import
 * directly from `@agor/core/templates/handlebars-helpers` instead.
 */

export type {
  AgorClient,
  AgorService,
  BoardsService,
  MessagesService,
  ReposCloneService,
  ReposLocalService,
  ReposService,
  ServiceTypes,
  SessionPromptOptions,
  SessionPromptResult,
  SessionsService,
  TaskRunOptions,
  TaskRunRequest,
  TasksClientHelpers,
  TasksService,
  TemplateRenderRequest,
  TemplateRenderResponse,
  TemplatesService,
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
// Browser-safe zone-trigger context builder (pure JS, no Handlebars). The
// daemon and MCP path render against this shape too — keep them in sync.
export {
  type BuildZoneTriggerContextInput,
  buildZoneTriggerContext,
} from '../templates/zone-trigger-context.js';
export * from '../types/index.js';
// Permission-mode helpers — pure functions, browser-safe.
export {
  type CodexPermissionDefaults,
  getDefaultCodexPermissionConfig,
  mapPermissionMode,
  mapToCodexPermissionConfig,
} from '../utils/permission-mode-mapper.js';
// URL / path builders — single source of truth shared by the daemon
// (full URLs on entity responses), the UI router (relative paths), and
// agent share-link generation. See `packages/core/src/utils/url.ts` for
// the path shape and `UI_MOUNT_PATH` convention.
export {
  artifactPath,
  boardPath,
  ENTITY_PATH_SEGMENTS,
  getArtifactUrl,
  getBoardUrl,
  getSessionUrl,
  getWorktreeUrl,
  sessionPath,
  UI_MOUNT_PATH,
  worktreePath,
} from '../utils/url.js';
