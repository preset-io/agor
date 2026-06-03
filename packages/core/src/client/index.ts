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
  BranchesService,
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
} from '../api/index.js';
export {
  createClient,
  createRestClient,
  getApiKeyFromEnv,
  isDaemonRunning,
} from '../api/index.js';

export * from '../config/browser.js';
export type { AgorConfig } from '../config/types.js';
// Global-search field registry — same module on client (V1 in-memory filter)
// and server (future V2 SQL fan-out per design doc §5.7).
export {
  matchSearchTokens,
  SEARCHABLE_FIELDS,
  type SearchFieldExtractor,
  tokenizeSearchQuery,
} from '../search/index.js';
// Browser-safe zone-trigger context builder (pure JS, no Handlebars). The
// daemon and MCP path render against this shape too — keep them in sync.
export {
  type BuildZoneTriggerContextInput,
  buildZoneTriggerContext,
} from '../templates/zone-trigger-context.js';
export * from '../types/index.js';
// Cron helpers — pure functions, browser-safe (cron-parser + cronstrue
// both ship browser builds). Drives the schedules UI's live "Every
// hour" preview, IANA-tz validation, and the visual cron picker preset.
export {
  CRON_PRESETS,
  type CronValidationResult,
  getNextRuns,
  getNextRunTime,
  getPrevRunTime,
  humanizeCron,
  isValidCron,
  resolveScheduleTz,
  roundToMinute,
  validateCron,
  validateCronWithResult,
} from '../utils/cron.js';
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
  branchPath,
  ENTITY_PATH_SEGMENTS,
  getArtifactUrl,
  getBoardUrl,
  getBranchUrl,
  getKnowledgeUrl,
  getSessionUrl,
  knowledgePath,
  sessionPath,
  UI_MOUNT_PATH,
} from '../utils/url.js';
