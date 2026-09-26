/**
 * Widget Registry — daemon-side dispatch map for in-conversation widgets.
 *
 * Each entry binds a `WidgetType` to its Zod schemas (for params validation),
 * its side-effect handler, and the two prompt-builder functions that produce
 * the system-authored auto-resume / dismissal prompts.
 *
 * A widget is *resolved*, and "resolved" is deliberately broader than
 * "submitted". The registry is a union of exactly two kinds, and what
 * separates them is **whether the entry accepts a request body**:
 *
 *   - `'submit'` (the default) — the browser POSTs a form body to
 *     `POST /widgets/:id/submit`. The entry validates it with `submitSchema`
 *     and applies it through `applySubmit`. `env_vars` and `gateway_token`
 *     work this way.
 *   - `'daemon_verified'` — there is no form body to trust, and none is
 *     accepted. The client reports that something finished and the entry's
 *     `resolveFromDaemonVerification` re-derives the outcome from durable
 *     daemon state rather than from anything the client asserted. `oauth`
 *     works this way, via `POST /widgets/:id/oauth-resolve` and the persisted
 *     grant.
 *
 *     The name is deliberately kind-neutral. Nothing about this machinery is
 *     OAuth-specific — a GitHub App install or a device-code flow is the same
 *     shape — and the next such widget should not have to register itself as an
 *     OAuth callback to get it. (The resolution ACTION is still
 *     `'oauth_callback'`: that names the endpoint the request arrived at and is
 *     persisted in `resolution_claim.action`, so it is a route/compatibility
 *     value rather than a statement about the machinery.)
 *
 * Body-or-no-body is the axis that carries weight, because it is what decides
 * the two things the resolver must get right: whether a payload is validated
 * at all, and which endpoint may resolve this type (`submissions.ts` refuses
 * the mismatch in both directions).
 *
 * Where `result_meta` comes from is NOT that axis, and used to be conflated
 * with it: only the bodiless variant could return its own. The result was that
 * `gateway_token` — whose outcome is decided by a probe inside `applySubmit`,
 * not by the body — had to smuggle that outcome to `buildResultMeta` through a
 * module-level `WeakMap` keyed on submit-object identity, and the next
 * form-backed, externally-verified widget would have needed a second one. Now
 * **either** handler may return the sanitized `result_meta`, and
 * `buildResultMeta` is the fallback for the case it was always right for: a
 * meta that is a pure projection of the body (`env_vars`).
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
 * guarantees the secret-doesn't-enter-context property (§5.1). It holds
 * whichever source produced the `result_meta`: a handler return is under the
 * same sanitization rule as `buildResultMeta`, and neither is ever handed the
 * body to pass through.
 */

import type { Application } from '@agor/core/feathers';
import type { SessionID, UserID, WidgetType } from '@agor/core/types';
import type { z } from 'zod';

/**
 * Context passed to a widget's `authorizeMint` hook — everything the daemon
 * knows at the moment a widget is about to be created, before the row exists.
 *
 * Deliberately NOT the same shape as {@link WidgetSubmitCtx}: at mint there is
 * no submitter, no claim, and no durable row. `userId`/`role` are the prompt
 * actor asking for the widget, which for a credential-minting widget is the
 * identity the credential would eventually land under.
 */
export interface WidgetMintCtx {
  app: Application;
  /** Session the widget will be minted into. */
  sessionId: SessionID;
  /** The prompt actor requesting the widget. */
  userId: UserID;
  /** The prompt actor's global role. `undefined` normalizes to member. */
  role: string | undefined;
  /** Feathers params carrying the caller's identity, for service reads. */
  serviceParams: unknown;
}

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
 * proof: `resolveFromDaemonVerification` re-reads the persisted grant and decides
 * for itself. A client that invents an attempt id resolves nothing.
 */
export interface WidgetDaemonVerifiedEvidence {
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
  /**
   * Optional gate on whether this widget may be CREATED at all, run by
   * `mintWidgetMessage` before the row is written. Throw (e.g. Forbidden) to refuse.
   *
   * This exists so a widget type owns its own preconditions instead of every
   * caller remembering to repeat them. The MCP tool that mints today and the
   * Slack projection that will mint tomorrow both go through `mintWidgetMessage`, so
   * neither can forget; a caller that wants to fail before doing expensive or
   * externally-visible setup work may ALSO call it early via
   * {@link authorizeWidgetMint}.
   *
   * `params` is absent on such an early call, because the destination is not
   * resolved yet. A hook must therefore enforce everything it can from the
   * context alone and treat params-dependent checks as additive. Both calls
   * run; the hook must be side-effect free and idempotent.
   */
  authorizeMint?: (ctx: WidgetMintCtx, params?: TParams) => void | Promise<void>;
  /**
   * Optional gate re-asked at RESOLVE time, before the durable claim and
   * before any handler side-effect. Throw to refuse.
   *
   * A mint-time gate answers "may this be asked for"; this answers "is that
   * still true now". They are different questions whenever the window between
   * them is long and the world can change inside it — which for a widget that
   * waits on a human is always. `applySubmit` /
   * `resolveFromDaemonVerification` may of course check more; this hook is for the
   * preconditions that are the SAME question as the mint-time one, so the two
   * can be written next to each other and stay in step.
   */
  authorizeResolve?: (ctx: WidgetSubmitCtx, params: TParams) => void | Promise<void>;
}

/**
 * The fields every submit-resolved entry has, whichever way it produces its
 * `result_meta`.
 *
 * Generic over its `params`, `submit`, and `result_meta` shapes so each
 * registered widget gets compile-time type checking on the four hand-off
 * boundaries (MCP tool → params, browser form → submit, daemon → result_meta,
 * daemon → auto-resume prompt).
 */
interface SubmitWidgetRegistryEntryBase<TParams, TSubmit, TResultMeta>
  extends WidgetRegistryEntryBase<TParams, TResultMeta> {
  /** Optional for back-compat: an entry that omits it is submit-resolved. */
  resolution?: 'submit';
  /** Validates `POST /widgets/:widget_id/submit` body. */
  submitSchema: z.ZodType<TSubmit>;
}

/**
 * The two ways a submit-resolved entry can produce its `result_meta`, as a
 * union rather than two optional fields.
 *
 * `buildResultMeta?` beside `applySubmit: … => Promise<TResultMeta | void>`
 * described a third arrangement that is never correct: an entry whose
 * `TResultMeta` is a real shape, with no builder and a handler free to return
 * nothing. `submissions.ts` then passes `undefined` to
 * `buildAutoResumePrompt(result_meta, params)`, which is declared to receive
 * the shape — so the prompt the agent is resumed with reads properties off
 * nothing. That is the failure F3 had already produced once by a different
 * route (a `WeakMap` miss answering with a blank channel id and
 * `enabled: false`: the right shape, the wrong answer), and the fix there was
 * to let the handler return its own meta. This makes "one of the two" the
 * type's rule rather than a convention.
 *
 * A widget that genuinely computes no meta is still expressible, and unchanged:
 * `TResultMeta` is `void`, the handler is `Promise<void>`, and the second
 * member admits it.
 */
type SubmitWidgetResultMetaSource<TSubmit, TParams, TResultMeta> =
  | {
      /**
       * Build the sanitized `result_meta` from the submit body alone — the
       * FALLBACK, used only when `applySubmit` returns nothing.
       *
       * Right for a meta that is a pure projection of what was submitted
       * (`env_vars` reports the names it saved and their scope). A handler
       * whose outcome depends on what its side-effect DID should return that
       * outcome instead; deriving it here would mean carrying it across two
       * calls.
       *
       * Either way the rule is the same and is not negotiable: MUST NOT
       * include secret values from the submit body — only names, scope,
       * labels, etc.
       */
      buildResultMeta: (submit: TSubmit) => TResultMeta;
      applySubmit: (
        ctx: WidgetSubmitCtx,
        submit: TSubmit,
        params: TParams
        // biome-ignore lint/suspicious/noConfusingVoidType: with a builder present, a handler that computes no meta is exactly the fallback case
      ) => Promise<TResultMeta | void>;
    }
  | {
      /** No fallback: this entry's handler is the only source. */
      buildResultMeta?: undefined;
      applySubmit: (ctx: WidgetSubmitCtx, submit: TSubmit, params: TParams) => Promise<TResultMeta>;
    };

/**
 * A widget resolved by a browser-submitted form body.
 *
 * `applySubmit` applies the submission's side-effect (encrypt + write env var,
 * attach MCP server, finalize OAuth, etc.). The submit endpoint runs it BEFORE
 * patching the widget message status to 'submitted'.
 *
 * It may RETURN the sanitized `result_meta`, which wins over
 * `buildResultMeta` — and MUST return one when the entry declares no builder.
 * Returning it is what a handler should do whenever the outcome is decided by
 * the side-effect rather than by the body (a credential probe's verdict, the
 * row an upsert settled on), because the alternative is carrying the value
 * from one call to the other outside the type.
 *
 * What it returns is `result_meta` and therefore reaches the agent's context
 * through `buildAutoResumePrompt`, so it is under exactly the sanitization
 * rule `buildResultMeta` is under: names, scopes, labels and outcomes, never a
 * submitted value.
 *
 * `params` is the original agent-provided params stored on the widget row —
 * available so the handler can cross-check the submit body against what was
 * originally requested (e.g. env_vars validates names match exactly).
 *
 * The durable resolver releases a live claim after `applySubmit` reports an
 * error so the user can correct and retry the widget. Implementations must
 * make that deliberate retry safe (normally by writing desired state
 * idempotently). Daemon death after an unknown outcome is different: the claim
 * stays `resolving` and is not replayed.
 */
export type SubmitWidgetRegistryEntry<TParams, TSubmit, TResultMeta> =
  SubmitWidgetRegistryEntryBase<TParams, TSubmit, TResultMeta> &
    SubmitWidgetResultMetaSource<TSubmit, TParams, TResultMeta>;

/**
 * A widget the DAEMON resolves by re-reading its own durable state, after a
 * client reports that some out-of-band flow finished.
 *
 * There is no submit body and no `submitSchema`: `POST /widgets/:id/submit`
 * refuses this kind outright, because accepting a form body here would mean
 * accepting a client's word for the outcome. Today the only member is `oauth`,
 * whose resolution arrives at `POST /widgets/:id/oauth-resolve` and whose
 * durable state is the persisted grant; the handler below is the only thing
 * that decides whether it really did.
 *
 * `resolveFromDaemonVerification` therefore MUST return the `result_meta`:
 * there is no body for a fallback builder to project, and the sanitized facts
 * come from the durable rows the handler just read. (Returning it is no longer
 * what makes this variant different — `applySubmit` may return one too. What
 * makes it different is that here it is the only source.)
 *
 * Retry safety is the same contract as `applySubmit`: a thrown error releases
 * the claim back to `pending`, so the handler must be idempotent (the OAuth
 * widget re-checks the grant and re-attaches, both of which are).
 */
export interface DaemonVerifiedWidgetRegistryEntry<TParams, TResultMeta>
  extends WidgetRegistryEntryBase<TParams, TResultMeta> {
  resolution: 'daemon_verified';
  /**
   * What a caller may do about a resolution SOMEONE ELSE started and did not
   * finish. Defaults to `'none'`, which is the generic policy every widget had
   * before: an abandoned `resolving` claim is a diagnosis, never a lease to
   * take over, because the daemon cannot know whether the prior handler's
   * external effect ran.
   *
   * `'reclaimable'` is an explicit statement by ONE widget type that its
   * handler has no such effect to duplicate — see
   * {@link WidgetResolutionRecoveryPolicy}. It is deliberately not available
   * on the submit variant: `applySubmit` writes env vars and restarts
   * connectors, and re-running one of those on a claim whose outcome is
   * unknown is exactly what the generic policy protects.
   */
  recovery?: WidgetResolutionRecoveryPolicy;
  resolveFromDaemonVerification: (
    ctx: WidgetSubmitCtx,
    evidence: WidgetDaemonVerifiedEvidence,
    params: TParams
  ) => Promise<TResultMeta>;
}

/**
 * How a resolution lane recovers from an interrupted resolution.
 *
 * - `'none'` — the generic, conservative policy. A widget that is not
 *   `pending` refuses every further resolution attempt. An abandoned
 *   `resolving` claim stays abandoned.
 * - `'reclaimable'` — the lane's resolution handler is idempotent and
 *   externally effect-free, so an interrupted resolution may be finished by a
 *   later authenticated attempt: an abandoned claim older than the resolver's
 *   cutoff is taken over, and a resolution that already completed answers
 *   success instead of a conflict.
 *
 * Only `oauth` declares `'reclaimable'` today, and the reason is specific
 * rather than general. Its three milestones — grant persisted, widget resolved
 * and server attached, agent resumed — are completed by three different
 * actors, and only the FIRST is completed by the provider callback. The other
 * two need the browser to come back and POST, so closing the page after
 * consent used to leave a real credential behind a pending card forever, with
 * nothing in the system able to finish it. Every step
 * `resolveFromDaemonVerification` performs is a re-read or an idempotent write
 * (the grant read decides; the attach is a unique-index upsert; the
 * auto-resume Task is keyed by `widgetAutoResumeTaskId`), so replaying it
 * duplicates nothing.
 */
export type WidgetResolutionRecoveryPolicy = 'none' | 'reclaimable';

/**
 * Whether this entry accepts a request body — the union's actual axis.
 *
 * A type predicate rather than a comparison at each call site, so the two
 * questions that follow from it stay together: whether a payload is validated,
 * and which of `/submit` and `/oauth-resolve` may resolve this type. The
 * resolver refuses the mismatch in both directions, because a bodiless entry
 * reached through `/submit` would be resolved on a client's say-so and a
 * body-taking entry reached through `/oauth-resolve` would skip its payload
 * validation entirely.
 */
export function widgetAcceptsSubmitBody<TParams, TSubmit, TResultMeta>(
  entry: WidgetRegistryEntry<TParams, TSubmit, TResultMeta>
): entry is SubmitWidgetRegistryEntry<TParams, TSubmit, TResultMeta> {
  return entry.resolution !== 'daemon_verified';
}

/** The recovery policy an entry declares, defaulting to the generic one. */
export function widgetRecoveryPolicy(
  entry: WidgetRegistryEntry<unknown, unknown, unknown> | undefined
): WidgetResolutionRecoveryPolicy {
  return entry?.resolution === 'daemon_verified' ? (entry.recovery ?? 'none') : 'none';
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
  | DaemonVerifiedWidgetRegistryEntry<TParams, TResultMeta>;

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

/**
 * Run a widget type's mint-time gate.
 *
 * The single entry point every mint path uses, so "did you remember to check"
 * is not a question a caller can answer wrongly.
 *
 * An unregistered type THROWS rather than passing. A widget whose entry is
 * missing is a widget whose gate is missing, and the whole point of moving
 * enforcement onto the type is that a mint cannot proceed without it — a
 * silent no-op here would restore exactly the failure mode this replaced
 * (something mints, nothing checks). It is also what the resolve path already
 * does for an unknown type.
 */
export async function authorizeWidgetMint(
  type: WidgetType,
  ctx: WidgetMintCtx,
  params?: unknown
): Promise<void> {
  const entry = widgetRegistry.get(type);
  if (!entry) {
    throw new Error(
      `Widget type '${type}' is not registered on this daemon; refusing to mint it. ` +
        `Widget types register at boot via registerAllWidgets().`
    );
  }
  await entry.authorizeMint?.(ctx, params);
}

/**
 * Validate the params a mint is about to freeze onto a widget row, and return
 * what the schema accepted.
 *
 * `authorizeWidgetMint` answers "may this be created"; this answers "is this
 * the shape the type declared". They are separate calls because the gate also
 * runs EARLY, before a destination is resolved, with no params to validate —
 * and because a caller that skipped this one would write an unvalidated
 * `params` blob into a row three surfaces render from.
 *
 * Running it at the seam rather than at each tool makes the guarantee uniform.
 * Every call site happens to parse already, but "happens to" is the whole
 * problem: the `oauth` lane's `already_present` short-circuit builds its
 * params with `satisfies OAuthWidgetParams`, which is a compile-time check
 * that strips nothing at runtime, so `.strict()` was enforced on one of that
 * type's two mint paths and not the other.
 *
 * The parsed value is returned, not discarded: a `.strict()` schema refuses an
 * unknown key and a plain object schema strips it, and the row should record
 * whichever the type asked for.
 */
export function parseWidgetMintParams(type: WidgetType, params: unknown): unknown {
  const entry = widgetRegistry.get(type);
  if (!entry) {
    throw new Error(
      `Widget type '${type}' is not registered on this daemon; refusing to mint it. ` +
        `Widget types register at boot via registerAllWidgets().`
    );
  }
  return entry.paramsSchema.parse(params);
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
