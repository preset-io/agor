/**
 * Widgets module barrel + central registration entry point.
 *
 * Each concrete widget type lives in its own subdirectory (e.g.
 * `./env-vars/`) and exports a `register*Widget()` side-effect. Daemon
 * startup calls `registerAllWidgets()` once at boot to populate the
 * registry that the submit/dismiss routes (and any future internal
 * callers) dispatch through.
 *
 * See `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

import { registerEnvVarsWidget } from './env-vars/index.js';

export type { WidgetRegistryEntry, WidgetSubmitCtx } from './registry.js';
export { getWidget, listWidgetTypes, registerWidget } from './registry.js';
export type {
  AuthenticatedCaller,
  WidgetResolutionAction,
  WidgetResolutionResult,
  WidgetResolverApp,
  WidgetResolverDeps,
} from './submissions.js';
export { canResolveWidget, resolveWidget } from './submissions.js';

/**
 * Register every built-in widget type. Idempotent — safe to call multiple
 * times (the registry no-ops on identical re-registration of the same entry).
 */
export function registerAllWidgets(): void {
  registerEnvVarsWidget();
}
