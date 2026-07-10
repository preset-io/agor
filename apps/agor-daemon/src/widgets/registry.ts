/**
 * Widget Registry — daemon-side dispatch map for in-conversation widgets.
 *
 * Each entry binds a `WidgetType` to its Zod schemas (for params + submit
 * validation), its side-effect handler (`applySubmit`), and the two
 * prompt-builder functions that produce the system-authored auto-resume /
 * dismissal prompts.
 *
 * PR 1 lands the framework only — there are no registered entries yet.
 * `env_vars`, `confirmation`, and `oauth` widgets each ship their own
 * registration in a later PR (see §7 of the design doc).
 *
 * The registry is intentionally module-local rather than a runtime
 * singleton — widget types register themselves via `registerWidget()` at
 * daemon boot (called from each widget type's index file) and the submit
 * handler looks them up via `getWidget()`. Empty in PR 1.
 *
 * Critical invariant: `buildAutoResumePrompt` receives only
 * `(result_meta, params)` — never the raw submit body. This is what
 * guarantees the secret-doesn't-enter-context property (§5.1).
 */

import type { Application } from '@agor/core/feathers';
import type { SessionID, UserID, WidgetType } from '@agor/core/types';
import type { z } from 'zod';

/**
 * Context passed to a widget's `applySubmit` handler. Contains just enough
 * to perform the side-effect (write env vars, attach an MCP server, etc.)
 * without exposing internals of the submit endpoint.
 */
export interface WidgetSubmitCtx {
  app: Application;
  /** The widget message's host session. */
  sessionId: SessionID;
  /** The user who submitted the widget (may differ from session creator). */
  submitterUserId: UserID;
  /** The submitter's role, used to construct Feathers auth params for any
   * internal service calls applySubmit makes. Service-layer hooks (e.g. the
   * users.patch self-only check at `register-hooks.ts:1481`) read
   * `params.user.role` to decide admin bypass — so applySubmit MUST pass these
   * along when patching protected services, or it gets 403'd. */
  submitterRole: string | undefined;
  /** Session creator — credentials get written to this identity. */
  sessionCreatorUserId: UserID;
}

/**
 * One widget type's registration. Generic over its `params`, `submit`, and
 * `result_meta` shapes so each registered widget gets compile-time type
 * checking on the four hand-off boundaries (MCP tool → params, browser
 * form → submit, daemon → result_meta, daemon → auto-resume prompt).
 */
export interface WidgetRegistryEntry<TParams, TSubmit, TResultMeta> {
  /** Discriminant matching `metadata.widget.widget_type`. */
  type: WidgetType;
  /** Version of this widget's `params`/`submit`/`result_meta` contract. */
  schemaVersion: number;
  /** Validates the MCP tool's input (drives `metadata.widget.params`). */
  paramsSchema: z.ZodType<TParams>;
  /** Validates `POST /widgets/:widget_id/submit` body. */
  submitSchema: z.ZodType<TSubmit>;
  /**
   * Build the sanitized `result_meta` written to the message row and fed
   * into `buildAutoResumePrompt`. MUST NOT include secret values from the
   * submit body — only names, scope, labels, etc.
   */
  buildResultMeta: (submit: TSubmit) => TResultMeta;
  /**
   * Apply the submission's side-effect (encrypt + write env var,
   * attach MCP server, finalize OAuth, etc.). The submit endpoint runs
   * this BEFORE patching the widget message status to 'submitted'.
   *
   * `params` is the original agent-provided params stored on the widget row —
   * available so the handler can cross-check the submit body against what was
   * originally requested (e.g. env_vars validates names match exactly).
   */
  applySubmit: (ctx: WidgetSubmitCtx, submit: TSubmit, params: TParams) => Promise<void>;
  /**
   * Build the user-role prompt auto-queued into the session's task queue
   * on submit. Takes only `result_meta` + `params` — never the raw submit
   * body — to keep submitted values out of the agent's context.
   */
  buildAutoResumePrompt: (resultMeta: TResultMeta, params: TParams) => string;
  /**
   * Build the user-role prompt auto-queued on dismissal. Should be
   * explicit ("don't immediately re-ask") to avoid agent loops.
   */
  buildDismissedPrompt: (params: TParams) => string;
  /**
   * Optional gate on WHO may dismiss this widget, run before the message is
   * marked 'dismissed'; throw (e.g. Forbidden) to reject. Absent means any
   * caller allowed to reach the resolve endpoint may dismiss. Admin-only
   * widgets set this so a dismissal can't sidestep the submit-side role check.
   */
  authorizeDismiss?: (ctx: WidgetSubmitCtx, params: TParams) => void | Promise<void>;
}

// Untyped variant used for storage / dispatch — the public API restores
// generics via the registerWidget()/getWidget() helpers.
type AnyWidgetEntry = WidgetRegistryEntry<unknown, unknown, unknown>;

const widgetRegistry: Map<WidgetType, AnyWidgetEntry> = new Map();

/**
 * Register a widget type. Idempotent re-registration with the same shape is
 * a no-op so test setup can re-register safely; conflicting re-registration
 * throws to catch accidental duplicates.
 */
export function registerWidget<TParams, TSubmit, TResultMeta>(
  entry: WidgetRegistryEntry<TParams, TSubmit, TResultMeta>
): void {
  const existing = widgetRegistry.get(entry.type);
  if (existing && existing !== (entry as unknown as AnyWidgetEntry)) {
    throw new Error(
      `Widget type '${entry.type}' already registered with a different entry. ` +
        `Each widget type may only be registered once.`
    );
  }
  widgetRegistry.set(entry.type, entry as unknown as AnyWidgetEntry);
}

/** Look up a widget by type. Returns `undefined` for unknown types. */
export function getWidget(type: WidgetType): AnyWidgetEntry | undefined {
  return widgetRegistry.get(type);
}

/** All registered widget types (for diagnostics / tests). */
export function listWidgetTypes(): WidgetType[] {
  return Array.from(widgetRegistry.keys());
}

/**
 * Clear the registry. ONLY for tests — production code must not call this.
 */
export function _resetWidgetRegistryForTests(): void {
  widgetRegistry.clear();
}
