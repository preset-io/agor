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

export function createSessionStreamsService(app: Application) {
  const assertAccessible = async (sessionId: string, params: Params): Promise<void> => {
    // Reuse the canonical session read as the access gate. Neutralize the
    // query so the sessions query validator doesn't reject control-plane
    // params, but preserve provider/connection/user/tenant so tenant scoping
    // and branch-view RBAC still apply.
    await app
      .service('sessions')
      .get(sessionId as never, { ...(params ?? {}), query: {} } as never);
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
      await assertAccessible(sessionId, params);
      joinSessionStreamChannel(app, sessionId, connection);
      return { session_id: sessionId, subscribed: true };
    },

    async remove(id: string, params: Params): Promise<SessionStreamSubscription> {
      const connection = (params as { connection?: unknown } | undefined)?.connection;
      const sessionId = typeof id === 'string' ? id : '';
      if (connection && sessionId) {
        leaveSessionStreamChannel(app, sessionId, connection);
      }
      return { session_id: sessionId, subscribed: false };
    },
  };
}
