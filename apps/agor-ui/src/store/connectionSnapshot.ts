/**
 * The committed connection state, readable outside React.
 *
 * `ConnectionProvider` publishes its value here when it commits. Board write
 * guards judge a held ticket against this at dispatch time, never against
 * the values their owner last rendered: a confirmation or a running batch can
 * outlive the component that captured its ticket, and a render-updated ref
 * would keep that component's last auth generation and connection forever.
 */

export interface ConnectionSnapshot {
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly outOfSync: boolean;
  /** Successful socket-auth generation. */
  readonly authGeneration: number;
}

const DISCONNECTED: ConnectionSnapshot = {
  connected: false,
  connecting: false,
  outOfSync: false,
  authGeneration: 0,
};

/**
 * One entry per mounted provider, in mount order: the most recently mounted
 * provider wins (the app has one; tests and marketing pages may nest).
 */
const published = new Map<object, ConnectionSnapshot>();

export function getConnectionSnapshot(): ConnectionSnapshot {
  let current = DISCONNECTED;
  for (const snapshot of published.values()) current = snapshot;
  return current;
}

/** Publish (or update) `publisher`'s snapshot. */
export function publishConnectionSnapshot(publisher: object, snapshot: ConnectionSnapshot): void {
  published.set(publisher, snapshot);
}

/** Withdraw `publisher`'s snapshot when it unmounts. */
export function withdrawConnectionSnapshot(publisher: object): void {
  published.delete(publisher);
}

/** Mirrors `useMutationGate().canMutate`. */
export function connectionAllowsWrites(snapshot: ConnectionSnapshot): boolean {
  return snapshot.connected && !snapshot.connecting && !snapshot.outOfSync;
}
