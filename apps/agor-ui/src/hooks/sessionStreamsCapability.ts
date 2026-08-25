import type { AgorClient } from '@agor-live/client';

/** Session-streams capability marker: no session id, joins no room. */
interface SessionStreamsCapabilityAnnounce {
  capability: true;
}

/**
 * Mark this connection session-streams aware so the daemon's owner fallback
 * skips it — even idle tabs that never open a transcript. Invoked on every
 * `connect`, which the daemon emits only after accepting the authenticated
 * handshake. Best-effort: a rejection just leaves this connection on the
 * owner fallback.
 */
export function announceSessionStreamsCapability(client: AgorClient): void {
  void (
    client.service('session-streams') as {
      create: (data: SessionStreamsCapabilityAnnounce) => Promise<unknown>;
    }
  )
    .create({ capability: true })
    .catch(() => {});
}
