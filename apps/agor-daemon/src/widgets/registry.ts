/**
 * Widget Registry — daemon-side dispatch map for in-conversation widgets.
 *
 * Each entry binds a `WidgetType` to its Zod schemas (for params validation),
 * its side-effect handler, and the two prompt-builder functions that produce
 * the system-authored auto-resume / dismissal prompts.
 *
 * A widget is *resolved*, and "resolved" is deliberately broader than
 * "submitted". Two resolution kinds exist:
 *
 *   - `'submit'` (the default) — the browser POSTs a form body to
 *     `POST /widgets/:id/submit`, the entry validates it with `submitSchema`
 *     and applies it through `applySubmit`. `env_vars` and `gateway_token`
 *     work this way.
 *   - `'oauth_callback'` — there is no form body to trust. The browser runs
 *     the ordinary MCP OAuth flow and then POSTs
 *     `/widgets/:id/oauth-resolve`; the entry's `resolveFromOAuthCallback`
 *     re-derives the outcome from durable daemon state (the persisted grant)
 *     rather than from anything the client asserted. `oauth` works this way.
 *
 * Everything downstream of the handler — the durable claim, the auto-resume
 * task, the terminal status patch, the `widget:resolved` broadcast — is the
 * same code for both kinds (`submissions.ts`), which is the point of the
 * split living here rather than in a second resolver.
 *
 * See §6.2 of `docs/internal/in-conversation-widgets-design-2026-05-19.md`
 * and `docs/internal/slack-mcp-oauth-connect-2026-09-16.md`.
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
  /** Session creator, used to keep session-scoped selections owner-bound. */
  sessionCreatorUserId: UserID;
  /**
   * Open a short tenant-scoped database unit.
   *
   * Handlers that read or write through a repository need one: the resolve
   * route enters tenant *context*, but a repository resolves its tenant from a
   * database *scope*. Kept as a callback (rather than handing over a scoped
   * handle) so the unit stays short and never spans the handler's external
   * work — the same rule `submissions.ts` follows around the claim.
   */
  runInTenantDatabaseScope<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Evidence a browser supplies when it reports that an OAuth flow finished.
 *
 * Advisory only. `attempt_id` identifies the durable OAuth attempt the browser
 * polled so the daemon can log and correlate, but no field here is trusted as
 * proof: `resolveFromOAuthCallback` re-reads the persisted grant and decides
 * for itself. A client that invents an attempt id resolves nothing.
 */
export interface WidgetOAuthCallbackEvidence {
  attempt_id?: string;
}

/** Fields every widget registration carries, whatever resolves it. */
interface WidgetRegistryEntryBase<TParams, TResultMeta> {
  /** Discriminant matching `metadata.widget.widget_type`. */
  type: WidgetType;
  /** Version of this widget's `params`/`submit`/`result_meta` contract. */
  schemaVersion: number;
  /** Validates the MCP tool's input (drives `metadata.widget.params`). */
  paramsSchema: z.ZodType<TParams>;
  /**
   * Build the user-role prompt auto-queued into the session's task queue
   * on resolution. Takes only `result_meta` + `params` — never the raw submit
   * body or any credential — to keep resolved values out of the agent's
   * context.
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

/**
 * A widget resolved by a browser-submitted form body.
 *
 * Generic over its `params`, `submit`, and `result_meta` shapes so each
 * registered widget gets compile-time type checking on the four hand-off
 * boundaries (MCP tool → params, browser form → submit, daemon → result_meta,
 * daemon → auto-resume prompt).
 */
export interface SubmitWidgetRegistryEntry<TParams, TSubmit, TResultMeta>
  extends WidgetRegistryEntryBase<TParams, TResultMeta> {
  /** Optional for back-compat: an entry that omits it is submit-resolved. */
  resolution?: 'submit';
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
   *
   * The durable resolver releases a live claim after this method reports an
   * error so the user can correct and retry the widget. Implementations must
   * make that deliberate retry safe (normally by writing desired state
   * idempotently). Daemon death after an unknown outcome is different: the
   * claim stays `resolving` and is not replayed.
   */
  applySubmit: (ctx: WidgetSubmitCtx, submit: TSubmit, params: TParams) => Promise<void>;
}

/**
 * A widget resolved by the completion of a browser OAuth flow.
 *
 * There is no submit body and no `submitSchema`: `POST /widgets/:id/submit`
 * refuses this kind outright, because accepting a form body here would mean
 * accepting a client's word that a grant exists. Resolution arrives at
 * `POST /widgets/:id/oauth-resolve`, and the handler below is the only thing
 * that decides whether it really did.
 *
 * `resolveFromOAuthCallback` therefore RETURNS the `result_meta` rather than
 * having it derived from a submit body — the sanitized facts come from the
 * durable rows the handler just read, not from the request.
 *
 * Retry safety is the same contract as `applySubmit`: a thrown error releases
 * the claim back to `pending`, so the handler must be idempotent (the OAuth
 * widget re-checks the grant and re-attaches, both of which are).
 */
export interface OAuthCallbackWidgetRegistryEntry<TParams, TResultMeta>
  extends WidgetRegistryEntryBase<TParams, TResultMeta> {
  resolution: 'oauth_callback';
  resolveFromOAuthCallback: (
    ctx: WidgetSubmitCtx,
    evidence: WidgetOAuthCallbackEvidence,
    params: TParams
  ) => Promise<TResultMeta>;
}

/**
 * One widget type's registration, in either resolution kind.
 *
 * The three type parameters are kept in this order — and `TSubmit` kept even
 * for the OAuth variant's call sites — so existing `WidgetRegistryEntry<P, S,
 * R>` annotations continue to mean what they meant.
 */
export type WidgetRegistryEntry<TParams, TSubmit, TResultMeta> =
  | SubmitWidgetRegistryEntry<TParams, TSubmit, TResultMeta>
  | OAuthCallbackWidgetRegistryEntry<TParams, TResultMeta>;

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
