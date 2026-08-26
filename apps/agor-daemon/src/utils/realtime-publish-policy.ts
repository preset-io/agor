import type { UserRole } from '@agor/core/types';

/**
 * The allowlist that decides which services may fan out over the socket at all.
 *
 * Feathers' default is the opposite of what a multi-tenant product wants. The
 * app-level publisher registered by `configureRealtimePublish` is the LAST
 * fallback in `@feathersjs/transport-commons`' precedence chain, so it runs for
 * EVERY service that emits an event — including the dozens of RPC-shaped custom
 * routes (`sessions/:id/fork`, `repos/clone`, `mcp-catalog/connect`, …) whose
 * authors never thought of themselves as publishing anything. A `create()` on
 * one of those emits `created` with its response body, and before this file
 * that body went to the whole tenant unless somebody remembered to write
 * `.publish(() => [])`.
 *
 * That default produced two real leaks: `mcp-catalog/connect` broadcasting a
 * `{ mcp_server, session }` pair whose server row can carry the caller's API
 * key, and `mcp-servers` `remove` broadcasting an unredacted row. Both were
 * fixed one at a time. The class is fixed here: a path with no entry below
 * reaches NOBODY.
 *
 * Two rules keep it that way:
 *
 *  1. `realtimePublishPolicyFor` returns `undefined` for an unlisted path and
 *     the publisher suppresses the event — locally and on the Redis relay.
 *  2. `assertRealtimePublishPolicyCoverage` runs at startup over the services
 *     actually registered on the app and throws if any of them is missing.
 *     So the safe outcome (silence) is automatic, and the DANGEROUS outcome —
 *     realtime quietly not working because a developer forgot the entry — is a
 *     boot failure with the path in the message, not a bug report.
 *
 * Adding a service therefore means adding a line here. Choosing `'none'` is a
 * perfectly good answer and is the right one for anything RPC-shaped; the point
 * is that somebody had to write it down.
 */

/**
 * Who may receive an event from a service.
 *
 * The branch-flavoured audiences differ only in where the branch id is read
 * from; all of them resolve to "connections whose user currently holds at least
 * `view` on that branch" when branch RBAC is on, and to the tenant channel when
 * it is off (there is no visibility model to enforce in that mode).
 */
export type RealtimePublishAudience =
  /** No realtime fan-out at all. Not relayed to other replicas either. */
  | 'none'
  /** Every authenticated connection in the event's tenant. */
  | 'tenant'
  /** Connections whose user can currently view the referenced board. */
  | 'board'
  /** Attached rows require every referenced branch; unattached rows inherit board visibility. */
  | 'board-resource'
  /** Branch-scoped; branch id read from the row (`branch_id`), or `context.id`. */
  | 'branch'
  /** Branch-scoped; branch id read from `params.route.id` of a `/branches/:id/…` route. */
  | 'branch-route'
  /** Branch-scoped; branch id read from the row, else resolved via its `session_id`. */
  | 'branch-or-session'
  /** Branch-scoped when a branch/session/task/message is attached, tenant-wide when not. */
  | 'branch-optional'
  /** Branch-scoped when the artifact has a branch, else its creator + admins, else service-only. */
  | 'artifact'
  /** Per-document / per-namespace reader set, resolved by `knowledge-realtime-publish`. */
  | 'knowledge';

export type RealtimePublishPolicy = {
  audience: RealtimePublishAudience;
  /**
   * Minimum authenticated browser role admitted to this event stream.
   *
   * This mirrors the service read floor at the publication boundary. Omitting
   * a listener in the official UI is not authorization: an adversarial client
   * can subscribe to any Feathers service event. Service-account connections
   * remain admitted independently for internal runtime plumbing.
   */
  minimumRole?: UserRole;
  /**
   * Why this audience. For a fan-out audience, name the consumer that breaks
   * without it; for `'none'`, say what makes silence correct. Reviewers read
   * this column, so "no consumer" is a real answer and "unknown" is not.
   */
  why: string;
};

const NO_CONSUMER = 'RPC-shaped route: the caller reads the response, nobody subscribes.';

/**
 * Every Feathers service path registered by the daemon, and who hears its
 * events. Keys are normalized paths (no leading slash), exactly as Feathers
 * reports them in `context.path`.
 */
export const REALTIME_PUBLISH_POLICY = {
  // ---------------------------------------------------------------------------
  // Session-scoped resources. `useAgorData` / `useMessages` / `SessionPanel`
  // drive the whole live transcript off these, and the executor's private
  // control events (`tasks termination_requested`, `messages
  // permission_resolved`) ride the same two paths before scope resolution.
  // ---------------------------------------------------------------------------
  sessions: {
    audience: 'branch-or-session',
    why: 'useAgorData + BranchModal SessionsTab track session rows live.',
  },
  tasks: {
    audience: 'branch-or-session',
    why: 'SessionPanel (queued/patched/removed) and useTaskCompletionChime; also carries the executor control + streaming events.',
  },
  messages: {
    audience: 'branch-or-session',
    why: 'useMessages renders the transcript from these; also carries streaming chunks and permission_resolved.',
  },
  'session-mcp-servers': {
    audience: 'branch-or-session',
    why: 'useAgorData tracks per-session MCP attachment.',
  },
  'session-env-selections': {
    audience: 'none',
    why: 'Selection names are credential metadata; there is no subscriber, and any future consumer needs an owner-aware disclosure decision.',
  },

  // ---------------------------------------------------------------------------
  // Branch-scoped resources.
  // ---------------------------------------------------------------------------
  branches: {
    audience: 'branch',
    why: 'useAgorData, BoardBranchList, EnvironmentTab and App.tsx all track branch rows; health-monitor also listens in-process.',
  },
  schedules: {
    audience: 'branch',
    why: 'BranchModal ScheduleTab lists schedules live.',
  },
  'branches/:id/permissions': {
    audience: 'none',
    why: 'Permission mutations invalidate authorization caches; editors use the mutation response.',
  },
  'boards/:id/permissions': {
    audience: 'none',
    why: 'Permission mutations invalidate authorization caches; editors use the mutation response.',
  },
  'workspace-preferences': {
    audience: 'none',
    why: 'Workspace settings are fetched by the settings and permissions forms.',
  },

  // ---------------------------------------------------------------------------
  // Board-attached resources that may or may not hang off a branch.
  // ---------------------------------------------------------------------------
  'board-objects': {
    audience: 'board-resource',
    minimumRole: 'member',
    why: 'useAgorData and BoardBranchList track card/zone placement live.',
  },
  'board-comments': {
    audience: 'board-resource',
    why: 'useAgorData renders comment threads live.',
  },
  artifacts: {
    audience: 'artifact',
    why: 'useAgorData and ArtifactFullscreenPage track artifact rows and the agor-query runtime request.',
  },

  // ---------------------------------------------------------------------------
  // Tenant-wide catalogs. These rows are already visible to any authenticated
  // member through an unscoped `find`, so the event adds no reach.
  // ---------------------------------------------------------------------------
  boards: {
    audience: 'board',
    why: 'useAgorData tracks boards and board-object mutations emitted as boards.patched.',
  },
  cards: { audience: 'board', why: 'useAgorData tracks cards for boards the viewer can access.' },
  'card-types': { audience: 'tenant', why: 'useAgorData tracks card type definitions.' },
  repos: { audience: 'tenant', why: 'useAgorData and App.tsx track repo rows and clone progress.' },
  users: {
    audience: 'tenant',
    minimumRole: 'member',
    why: 'useAgorData keeps the user directory current for attribution. rowToUser computes agentic_tools_public_values PER REQUESTER (decrypted plaintext, owner only), so redactUserOwnerOnlyFieldsForBroadcast strips it from context.dispatch — the audience is tenant-wide, so the payload must carry nothing the row owner alone may see.',
  },
  'mcp-servers': {
    audience: 'tenant',
    why: 'useAgorData tracks server rows, and useMcpMemberPolicy refetches its caller-specific capability on the empty member-policy invalidation. Secrets are stripped from context.dispatch unconditionally by redactMCPServerSecretFields — the audience is tenant-wide, so row payloads must never carry credentials.',
  },
  'gateway-channels': {
    audience: 'tenant',
    why: 'useAgorData tracks Slack/GitHub channel config.',
  },
  'agentic-tool-settings': {
    audience: 'tenant',
    why: 'useAgorData upserts tenant tool settings from created/patched.',
  },

  // ---------------------------------------------------------------------------
  // Knowledge base. Audience is the per-document / per-namespace reader set
  // computed by `resolveKnowledgeRealtimeUserIds`, which owns these paths
  // wholesale — including suppressing `created` on the three search/edit/reindex
  // paths. Listed individually so a new kb/* service still has to declare itself.
  // ---------------------------------------------------------------------------
  'kb/documents': { audience: 'knowledge', why: 'Readers of the document.' },
  'kb/namespaces': { audience: 'knowledge', why: 'Users holding a permission on the namespace.' },
  'kb/versions': { audience: 'knowledge', why: 'Readers of the document the version belongs to.' },
  'kb/graph': { audience: 'knowledge', why: 'Readers of the documents the edge connects.' },
  'kb/settings': { audience: 'knowledge', why: 'Knowledge admins only.' },
  'kb/indexing/status': { audience: 'knowledge', why: 'Knowledge admins only.' },
  'kb/search': {
    audience: 'knowledge',
    why: 'created is suppressed outright — a query result is per-caller.',
  },
  'kb/document-edits': { audience: 'knowledge', why: 'created is suppressed outright.' },
  'kb/indexing/reindex': { audience: 'knowledge', why: 'created is suppressed outright.' },

  // ---------------------------------------------------------------------------
  // Silent: services that already opted out with their own `.publish(() => [])`.
  // Their service-level publisher wins over the app-level one, so these entries
  // are documentation plus coverage — but they must agree with the code.
  // ---------------------------------------------------------------------------
  'session-streams': {
    audience: 'none',
    why: 'Subscription control plane. Joining a room must not tell the tenant who is watching what.',
  },
  'messages/streaming': {
    audience: 'none',
    why: 'Executor ingest for message chunks; the fan-out is the messages service.',
  },
  'tasks/streaming': {
    audience: 'none',
    why: 'Executor ingest for task chunks; the fan-out is the tasks service.',
  },
  'gateway-channels/test': {
    audience: 'none',
    why: 'Connectivity probe result belongs to the caller.',
  },
  'gateway-channels/app-info': { audience: 'none', why: 'Probe result belongs to the caller.' },
  'opencode-auth': { audience: 'none', why: 'Credential control plane.' },
  'opencode-models': { audience: 'none', why: 'Per-caller model list.' },

  // ---------------------------------------------------------------------------
  // Silent: authentication and credential control planes. These are the paths
  // whose results must never reach a second connection under any circumstance;
  // most are also named in REDIS_FEATHERS_DENIED_PATHS as a second barrier.
  // ---------------------------------------------------------------------------
  authentication: { audience: 'none', why: 'Issues the caller a JWT.' },
  'authentication/refresh': { audience: 'none', why: 'Issues the caller a JWT.' },
  'authentication/impersonate': { audience: 'none', why: 'Issues a JWT for another identity.' },
  'auth/launch': { audience: 'none', why: 'Exchanges a launch token for a session.' },
  'check-auth': { audience: 'none', why: 'Echoes back the API key it was asked to validate.' },
  'config/resolve-api-key': { audience: 'none', why: 'Returns a provider API key.' },
  'executor-git-environment': {
    audience: 'none',
    why: 'Returns a command-scoped Git credential DTO to one executor.',
  },
  'api/v1/user/api-keys': { audience: 'none', why: 'Returns a freshly minted user API key.' },
  terminals: {
    audience: 'none',
    why: 'Shell control plane; output rides native terminal:* socket packets.',
  },
  'codex-auth/device': { audience: 'none', why: 'OAuth device flow for one caller.' },
  'codex-auth/import': {
    audience: 'none',
    why: 'Imports Codex credentials belonging to the caller.',
  },
  'codex-auth/logout': { audience: 'none', why: 'Credential control plane.' },
  'mcp-servers/oauth-start': { audience: 'none', why: 'OAuth control plane.' },
  'mcp-servers/oauth-browser-reservations': {
    audience: 'none',
    why: 'Returns a caller/socket-bound one-shot browser capability.',
  },
  'mcp-servers/oauth-callback': {
    audience: 'none',
    why: 'OAuth redirect handler (Express middleware, listed defensively).',
  },
  'mcp-servers/oauth-complete': {
    audience: 'none',
    why: 'OAuth control plane; completion is signalled by the native oauth:completed packet.',
  },
  'mcp-servers/oauth-disconnect': {
    audience: 'none',
    why: 'Signalled by the native oauth:disconnected packet.',
  },
  'mcp-servers/oauth-status': { audience: 'none', why: 'Per-user token status.' },
  'mcp-servers/oauth-attempt-status': {
    audience: 'none',
    why: 'Per-attempt status polled by the initiating tab.',
  },
  'mcp-servers/oauth-auth-headers': { audience: 'none', why: 'Returns bearer headers.' },
  'mcp-servers/oauth-refresh': { audience: 'none', why: 'Returns refreshed tokens.' },
  'mcp-servers/test-oauth': { audience: 'none', why: 'Probe result belongs to the caller.' },
  'mcp-servers/test-jwt': { audience: 'none', why: 'Probe result belongs to the caller.' },
  'mcp-servers/discover': {
    audience: 'none',
    why: 'Capability probe run with credentials belonging to the caller; its result is per-caller.',
  },
  'mcp-catalog/connect': {
    audience: 'none',
    why: 'Returns { mcp_server, session } where an api-key entry carries a credential belonging to the caller. This is the leak that motivated the allowlist.',
  },
  'mcp-catalog': { audience: 'none', why: 'find/get only — a static curated catalog, no events.' },
  'mcp-catalog/readiness': {
    audience: 'none',
    why: 'Caller-scoped advisory read with no mutations or events.',
  },
  'mcp-marketplace': {
    audience: 'none',
    why: 'Caller-private overview returned only to the requesting connection.',
  },
  'mcp-marketplace/remove-unattached': {
    audience: 'none',
    why: 'Caller-private acknowledgement; an explicit empty user-room freshness hint refreshes every owner device.',
  },
  'mcp-marketplace/tool-permission': {
    audience: 'none',
    why: 'Caller-private acknowledgement; an explicit empty user-room freshness hint refreshes every affected owner/admin device.',
  },
  'mcp-member-policy': { audience: 'none', why: 'Policy read for the caller.' },
  'mcp-egress/status': {
    audience: 'none',
    why: 'Tenant-scoped rollout and health status; Settings refetches explicitly.',
  },

  // ---------------------------------------------------------------------------
  // Silent: CRUD services with no realtime consumer. Denying costs nothing
  // today; a future consumer flips the entry deliberately.
  // ---------------------------------------------------------------------------
  groups: { audience: 'none', why: 'Group admin UI refetches; no socket subscriber.' },
  'group-memberships': { audience: 'none', why: 'Group admin UI refetches; no socket subscriber.' },
  'agentic-tool-presets': { audience: 'none', why: 'Read-mostly presets; no socket subscriber.' },
  templates: { audience: 'none', why: 'Static template list.' },
  leaderboard: { audience: 'none', why: 'Analytics rollup, polled.' },
  'thread-session-map': { audience: 'none', why: 'Gateway-internal thread bookkeeping.' },
  gateway: { audience: 'none', why: 'Inbound/outbound message routing; no socket subscriber.' },
  file: { audience: 'none', why: 'Reads a file out of a branch worktree for the caller.' },
  files: { audience: 'none', why: 'Lists files for the caller.' },
  'claude-models': { audience: 'none', why: 'Per-caller model list.' },
  'copilot-models': { audience: 'none', why: 'Per-caller model list.' },
  'cursor-models': { audience: 'none', why: 'Per-caller model list.' },
  health: { audience: 'none', why: 'Liveness probe.' },
  'boards/:id/aligned-branches': { audience: 'none', why: 'Query route.' },
  'boards/:id/effective-access': { audience: 'none', why: 'Query route.' },
  'branches/:id/effective-access': { audience: 'none', why: 'Query route.' },
  'branches/:id/fs-access-users': { audience: 'none', why: 'Query route.' },
  'me/artifact-trust-grants': { audience: 'none', why: 'Trust grants belonging to the caller.' },

  // ---------------------------------------------------------------------------
  // Silent: RPC routes. Each of these emits `created`/`patched` carrying its own
  // response body purely because Feathers treats every `app.use` as a service.
  // Their durable effects reach the UI through the CRUD service they mutate
  // (a fork emits `sessions created`; a start emits `branches patched`).
  // ---------------------------------------------------------------------------
  'sessions/:id/fork': {
    audience: 'none',
    why: `${NO_CONSUMER} The new session arrives as sessions.created.`,
  },
  'sessions/:id/spawn': {
    audience: 'none',
    why: `${NO_CONSUMER} The new session arrives as sessions.created.`,
  },
  'sessions/:id/prompt': {
    audience: 'none',
    why: `${NO_CONSUMER} The task arrives as tasks.created/queued.`,
  },
  'sessions/:id/initialize': {
    audience: 'none',
    why: `${NO_CONSUMER} Setup and task changes arrive through their owning services.`,
  },
  'sessions/:id/spawn-prompt': { audience: 'none', why: NO_CONSUMER },
  'sessions/:id/stop': { audience: 'none', why: `${NO_CONSUMER} Stop lands as tasks.patched.` },
  'sessions/:id/archive': { audience: 'none', why: `${NO_CONSUMER} Lands as sessions.patched.` },
  'sessions/:id/unarchive': { audience: 'none', why: `${NO_CONSUMER} Lands as sessions.patched.` },
  'sessions/:id/genealogy': { audience: 'none', why: NO_CONSUMER },
  'sessions/:id/env-selections': {
    audience: 'none',
    why: `${NO_CONSUMER} Lands as session-env-selections.`,
  },
  'sessions/:id/mcp-servers': {
    audience: 'none',
    why: `${NO_CONSUMER} Lands as session-mcp-servers.`,
  },
  'sessions/:id/permission-decision': {
    audience: 'none',
    why: 'The decision reaches the executor as messages.permission_resolved on its private task room.',
  },
  'sessions/:id/restart-cli': { audience: 'none', why: NO_CONSUMER },
  'sessions/:id/tasks/queue': { audience: 'none', why: `${NO_CONSUMER} Lands as tasks.queued.` },
  'tasks/:id/run': { audience: 'none', why: `${NO_CONSUMER} Lands as tasks.patched.` },
  'tasks/:id/complete': { audience: 'none', why: `${NO_CONSUMER} Lands as tasks.patched.` },
  'tasks/:id/fail': { audience: 'none', why: `${NO_CONSUMER} Lands as tasks.patched.` },
  'branches/:id/start': { audience: 'none', why: `${NO_CONSUMER} Lands as branches.patched.` },
  'branches/:id/stop': { audience: 'none', why: `${NO_CONSUMER} Lands as branches.patched.` },
  'branches/:id/restart': { audience: 'none', why: `${NO_CONSUMER} Lands as branches.patched.` },
  'branches/:id/nuke': { audience: 'none', why: `${NO_CONSUMER} Lands as branches.patched.` },
  'branches/:id/health': { audience: 'none', why: NO_CONSUMER },
  'branches/:id/render-environment': {
    audience: 'none',
    why: 'Renders the environment template, which can interpolate secrets.',
  },
  'branches/logs': {
    audience: 'none',
    why: 'Environment logs can contain secrets echoed by a dev server.',
  },
  'branches/:id/archive-or-delete': {
    audience: 'none',
    why: `${NO_CONSUMER} Lands as branches.patched/removed.`,
  },
  'branches/:id/unarchive': { audience: 'none', why: `${NO_CONSUMER} Lands as branches.patched.` },
  'branches/:id/execute-schedule-now': { audience: 'none', why: NO_CONSUMER },
  'branches/:id/fire-zone-trigger': { audience: 'none', why: NO_CONSUMER },
  'schedules/:id/run-now': { audience: 'none', why: `${NO_CONSUMER} Lands as schedules.patched.` },
  'boards/:id/archive': { audience: 'none', why: `${NO_CONSUMER} Lands as boards.patched.` },
  'boards/:id/unarchive': { audience: 'none', why: `${NO_CONSUMER} Lands as boards.patched.` },
  'boards/:id/sessions': { audience: 'none', why: NO_CONSUMER },
  'board-comments/:id/reply': {
    audience: 'none',
    why: `${NO_CONSUMER} Lands as board-comments.created.`,
  },
  'board-comments/:id/toggle-reaction': {
    audience: 'none',
    why: `${NO_CONSUMER} Lands as board-comments.patched.`,
  },
  'board-comments/:id/reposition': {
    audience: 'none',
    why: `${NO_CONSUMER} Lands as board-comments.patched.`,
  },
  'repos/local': { audience: 'none', why: `${NO_CONSUMER} Lands as repos.created.` },
  'repos/clone': { audience: 'none', why: `${NO_CONSUMER} Clone URLs can embed credentials.` },
  'repos/:id/branches': { audience: 'none', why: `${NO_CONSUMER} Lands as branches.created.` },
  'repos/:id/branches/:name': { audience: 'none', why: NO_CONSUMER },
  'repos/:id/import-agor-yml': { audience: 'none', why: NO_CONSUMER },
  'repos/:id/export-agor-yml': { audience: 'none', why: NO_CONSUMER },
  'artifacts/:id/payload': { audience: 'none', why: `${NO_CONSUMER} Lands as artifacts.patched.` },
  'artifacts/:id/console': {
    audience: 'none',
    why: 'Artifact console output is fetched by the viewing tab.',
  },
  'artifacts/:id/sandpack-error': { audience: 'none', why: NO_CONSUMER },
  'artifacts/:id/runtime-response/:requestId': {
    audience: 'none',
    why: 'The DOM answer goes back to the one agent that asked, in-process.',
  },
  'artifacts/:id/trust': { audience: 'none', why: `${NO_CONSUMER} Lands as artifacts.patched.` },
  'widgets/:id/submit': {
    audience: 'none',
    why: 'Widget input is deliberately kept out of broadcast.',
  },
  'widgets/:id/dismiss': {
    audience: 'none',
    why: 'Widget input is deliberately kept out of broadcast.',
  },
} as const satisfies Record<string, RealtimePublishPolicy>;

export type RealtimePublishPolicyPath = keyof typeof REALTIME_PUBLISH_POLICY;

const POLICY: ReadonlyMap<string, RealtimePublishPolicy> = new Map(
  Object.entries(REALTIME_PUBLISH_POLICY as Record<string, RealtimePublishPolicy>)
);

/**
 * Normalize a Feathers path for lookup. Feathers strips slashes when it
 * registers a service, but `emitServiceEvent` call sites and the Redis relay
 * envelope both carry a hand-written string, so normalize on both sides rather
 * than trusting them to match.
 */
export function normalizeRealtimePublishPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * The declared policy for a path, or `undefined` when the path was never
 * declared. `undefined` means DENY — callers must not treat it as "no opinion".
 */
export function realtimePublishPolicyFor(
  path: string | null | undefined
): RealtimePublishPolicy | undefined {
  if (!path) return undefined;
  return POLICY.get(normalizeRealtimePublishPath(path));
}

/** Convenience for the publisher's gate. */
export function isRealtimePublishAllowed(path: string | null | undefined): boolean {
  const policy = realtimePublishPolicyFor(path);
  return policy !== undefined && policy.audience !== 'none';
}

/**
 * Paths that are registered on the Feathers app but are Express middleware
 * rather than services, so they never emit an event and never reach the
 * publisher. They are listed so the source-scan coverage test can tell
 * "deliberately not a service" apart from "somebody forgot".
 */
export const NON_SERVICE_REGISTERED_PATHS: ReadonlySet<string> = new Set([
  '', // SPA fallback
  'static', // express.static
]);

export class RealtimePublishPolicyCoverageError extends Error {
  constructor(public readonly missingPaths: string[]) {
    super(
      `Realtime publish policy is missing an entry for: ${missingPaths.join(', ')}.\n` +
        `Every Feathers service must declare who may receive its events in ` +
        `apps/agor-daemon/src/utils/realtime-publish-policy.ts. Events from an ` +
        `undeclared service are suppressed, so realtime for it would silently ` +
        `do nothing. Add { audience: 'none', why: '…' } if that is what you want.`
    );
    this.name = 'RealtimePublishPolicyCoverageError';
  }
}

type ServiceRegistry = { services?: Record<string, unknown> };

/**
 * Throw unless every service registered on `app` has declared an audience.
 *
 * Called once at startup after all three registration phases. Deterministic —
 * it reads the registration table, not request data — so a deployment that
 * boots in CI boots in production.
 */
export function assertRealtimePublishPolicyCoverage(app: unknown): void {
  const registered = Object.keys((app as ServiceRegistry).services ?? {});
  const missing = registered
    .map(normalizeRealtimePublishPath)
    .filter((path) => !POLICY.has(path) && !NON_SERVICE_REGISTERED_PATHS.has(path))
    .sort();
  if (missing.length > 0) throw new RealtimePublishPolicyCoverageError(missing);
}
