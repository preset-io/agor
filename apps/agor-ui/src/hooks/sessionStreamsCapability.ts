import type { AgorClient } from '@agor-live/client';

/** Session-streams capability marker: no session id, joins no room. */
interface SessionStreamsCapabilityAnnounce {
  capability: true;
}

const CAPABILITY_ANNOUNCED_CLIENTS = new WeakSet<AgorClient>();

/**
 * Mark this connection session-streams aware so the daemon's owner fallback
 * skips it — even idle tabs that never open a transcript. Fires after
 * authentication (initial and every reconnect re-auth); idempotent per client.
 */
export function ensureSessionStreamsCapabilityAnnounce(client: AgorClient): void {
  if (CAPABILITY_ANNOUNCED_CLIENTS.has(client)) return;
  CAPABILITY_ANNOUNCED_CLIENTS.add(client);

  const announce = () => {
    // Best-effort: a rejection just leaves this connection on the owner fallback.
    void (
      client.service('session-streams') as {
        create: (data: SessionStreamsCapabilityAnnounce) => Promise<unknown>;
      }
    )
      .create({ capability: true })
      .catch(() => {});
  };

  // Announce post-auth, not on raw `connect`: session-streams.create requires
  // auth, so a pre-auth call would 401 and needlessly refresh+retry. Feathers
  // emits `authenticated` after every authenticate() (initial + reconnects).
  client.on('authenticated', announce);
}
