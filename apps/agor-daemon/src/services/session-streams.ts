import type { Application } from '@agor/core/feathers';
import { BadRequest } from '@agor/core/feathers';
import type { Params } from '@agor/core/types';
import { joinSessionStreamChannel, leaveSessionStreamChannel } from '../utils/realtime-publish.js';

/**
 * `session-streams` — a realtime control-plane service that lets a browser
 * declare interest in a session's streaming events. Subscribing joins the
 * calling CONNECTION to the per-session stream channel so the daemon can route
 * high-frequency streaming chunks to only the tabs viewing that session,
 * instead of broadcasting them to the whole tenant.
 *
 * Access is gated by a tenant-scoped `sessions.get`, which runs the same auth /
 * tenant / branch-view checks a normal session read does — no weaker path to a
 * session's live text than to its stored messages. Feathers drops connections
 * from channels automatically on disconnect, so unsubscribe on refresh /
 * navigation is best-effort; the socket teardown is the real cleanup.
 */
export interface SessionStreamSubscription {
  session_id: string;
  subscribed: boolean;
}

interface SubscribeData {
  session_id?: string;
  sessionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A full session UUID needs no short-id/alias resolution before leaving. */
function isCanonicalSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

export function createSessionStreamsService(app: Application) {
  // Reuse the canonical session read as the access gate AND to resolve the
  // caller-supplied id (which may be a short id / alias) to the row's full
  // session_id. Neutralize the query so the sessions query validator doesn't
  // reject control-plane params, but preserve provider/connection/user/tenant
  // so tenant scoping and branch-view RBAC still apply. Returns the canonical
  // session_id, or null when the row carries none.
  const resolveAccessibleSessionId = async (
    sessionId: string,
    params: Params
  ): Promise<string | null> => {
    const session = (await app
      .service('sessions')
      .get(sessionId as never, { ...(params ?? {}), query: {} } as never)) as
      | { session_id?: string }
      | null
      | undefined;
    return session?.session_id ?? null;
  };

  return {
    async create(data: SubscribeData, params: Params): Promise<SessionStreamSubscription> {
      const connection = (params as { connection?: unknown } | undefined)?.connection;
      if (!connection) {
        throw new BadRequest('session stream subscription requires a realtime connection');
      }
      const sessionId = data?.session_id ?? data?.sessionId;
      if (!sessionId || typeof sessionId !== 'string') {
        throw new BadRequest('session_id is required');
      }
      // Join the CANONICAL room id so short-id / alias callers land in the same
      // room publishers emit to (they carry the full UUID).
      const canonicalId = (await resolveAccessibleSessionId(sessionId, params)) ?? sessionId;
      joinSessionStreamChannel(app, canonicalId, connection);
      return { session_id: canonicalId, subscribed: true };
    },

    async remove(id: string, params: Params): Promise<SessionStreamSubscription> {
      const connection = (params as { connection?: unknown } | undefined)?.connection;
      const sessionId = typeof id === 'string' ? id : '';
      if (!connection || !sessionId) {
        return { session_id: sessionId, subscribed: false };
      }
      // The client sends the canonical (full UUID) id it stored from subscribe,
      // so skip the resolving round-trip when the id is already canonical. Only
      // a short-id / alias caller needs a lookup. Unsubscribing must not require
      // access (a revoked user still needs to leave), so fall back to the raw id
      // if the read fails.
      let canonicalId = sessionId;
      if (!isCanonicalSessionId(sessionId)) {
        try {
          canonicalId = (await resolveAccessibleSessionId(sessionId, params)) ?? sessionId;
        } catch {
          // Best-effort: leave under the supplied id; socket teardown is the
          // ultimate cleanup regardless.
        }
      }
      leaveSessionStreamChannel(app, canonicalId, connection);
      return { session_id: canonicalId, subscribed: false };
    },
  };
}
