/**
 * Widget Types
 *
 * In-conversation interactive widgets — small UI primitives that agents
 * render inline in a session's transcript to capture user input without that
 * input ever entering the LLM's context.
 *
 * Architecture lives in `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 * The MCP tool fires and returns; the widget message persists in the
 * transcript and is resolved when the user submits/dismisses via the
 * `widget-submissions` daemon service.
 */

import type { MessageID, UserID } from './id';

/** Lifecycle status of a widget request. */
export type WidgetStatus = 'pending' | 'submitted' | 'dismissed' | 'already_present';

/**
 * Widget type discriminant. PR 1 ships the framework with no concrete
 * widget types registered; later PRs add `'env_vars'`, `'confirmation'`, etc.
 * String widening keeps the framework forward-compatible with newer clients
 * registering widgets the daemon doesn't yet know about — the UI dispatcher
 * falls back to an "Unknown widget type" placeholder.
 */
export type WidgetType = string;

/**
 * Shape stored at `messages.metadata.widget` for `type === 'widget_request'`
 * rows. The row IS the widget — single source of truth for transcript
 * rendering, WebSocket events, and the submit-handler's state machine.
 *
 * Discriminated over `widget_type` so each registered widget can refine
 * `params` and `result_meta` to its own shape. `schema_version` is baked in
 * from v1 so future widget evolutions can be detected client-side.
 *
 * `result_meta` is the only payload that flows back into the agent's context
 * (via the auto-resume task prompt). It MUST NOT contain any submitted secret
 * values — see §5.1 of the design doc.
 */
export interface WidgetMessageMetadata<
  TType extends WidgetType = WidgetType,
  TParams = unknown,
  TResultMeta = unknown,
> {
  /** Discriminant identifying which widget type this is. */
  widget_type: TType;
  /** Stable widget id; equals the host message's `message_id`. */
  widget_id: MessageID;
  /** Per-widget-type version of `params`/`submit`/`result_meta`. */
  schema_version: number;
  /** Agent-provided parameters that drive widget rendering. NEVER contains user-supplied values. */
  params: TParams;
  /** Current lifecycle state. */
  status: WidgetStatus;
  /** ISO 8601 timestamp the agent requested the widget. */
  requested_at: string;
  /** ISO 8601 timestamp of submit/dismiss/short-circuit. Unset while pending. */
  resolved_at?: string;
  /**
   * Sanitized post-resolution data — names, scope choices, option labels, etc.
   * NEVER includes secret values. Used to build the auto-resume prompt.
   */
  result_meta?: TResultMeta;
  /** User who resolved the widget (may differ from session creator under prompt-tier RBAC). */
  submitted_by?: UserID;
  /**
   * Whether to auto-queue a system-authored prompt back into the agent on
   * resolution. Per design D6 defaults to `true`; agents opt-out by passing
   * `auto_resume: false` to the MCP tool.
   */
  auto_resume?: boolean;
}
