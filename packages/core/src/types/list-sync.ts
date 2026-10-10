/**
 * Versioned list reads ("list sync").
 *
 * A reconnecting client used to re-download every row of the workspace
 * collections it keeps in memory, because realtime events have no replay. A
 * list-sync read returns the same rows the plain `find` would, except that a
 * row the client already holds, byte for byte, comes back as a small integer
 * instead of the full object.
 *
 * Protocol (one `find` page):
 *
 * - Request: the normal query plus `$sync: { known }`, where `known` is the
 *   concatenation of the {@link LIST_SYNC_HASH_LENGTH}-character versions the
 *   client holds for this collection (possibly empty).
 * - Response: always paginated. `data[i]` is either a full row, or a number
 *   `n` meaning "the row whose version is `known` slot `n`, unchanged".
 *   `$sync.versions` concatenates the versions of the full rows, in order.
 *
 * A version is a hash of the row exactly as the server serializes it to this
 * caller, after every authorization, redaction and projection hook. No clocks
 * or per-row timestamps are involved, so it is immune to clock skew and to
 * write paths that don't bump `updated_at`. Rows deleted, archived or no
 * longer visible are simply absent from the scoped read, as in a full read.
 */

/** Characters per version (base64url, 72 bits). */
export const LIST_SYNC_HASH_LENGTH = 12;

/** Upper bound on versions a client may send for one collection. */
export const LIST_SYNC_MAX_KNOWN = 20_000;

/** The query key carrying the client's known versions. */
export const LIST_SYNC_QUERY_KEY = '$sync';

/**
 * Collections served as versioned lists, with each one's id field. These are
 * the sets the workspace store reads in full (a board's partition, comments,
 * the board list) and reads again on reconnect.
 */
export const LIST_SYNC_ID_FIELDS = {
  sessions: 'session_id',
  branches: 'branch_id',
  'board-objects': 'object_id',
  'board-comments': 'comment_id',
  cards: 'card_id',
  boards: 'board_id',
} as const;

export type ListSyncPath = keyof typeof LIST_SYNC_ID_FIELDS;

export interface ListSyncQuery {
  /** Concatenated versions the client holds. */
  known: string;
}

export interface ListSyncPage<T> {
  total: number;
  limit: number;
  skip: number;
  /** Full row, or the `known` slot index of an unchanged row. */
  data: Array<T | number>;
  $sync: {
    /** Concatenated versions of the full rows in `data`, in order. */
    versions: string;
  };
}

const VERSION_ALPHABET = /^[A-Za-z0-9_-]*$/;

export function isListSyncPath(path: string): path is ListSyncPath {
  return Object.hasOwn(LIST_SYNC_ID_FIELDS, path);
}

/** Concatenate versions for a request, dropping any that are malformed. */
export function encodeListSyncKnown(versions: Iterable<string>): string {
  let known = '';
  let count = 0;
  for (const version of versions) {
    if (count >= LIST_SYNC_MAX_KNOWN) break;
    if (version.length !== LIST_SYNC_HASH_LENGTH || !VERSION_ALPHABET.test(version)) continue;
    known += version;
    count += 1;
  }
  return known;
}

/**
 * Split a concatenated version string. Returns null when it is not a whole
 * number of well-formed versions or exceeds {@link LIST_SYNC_MAX_KNOWN}.
 */
export function splitListSyncVersions(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  if (value.length % LIST_SYNC_HASH_LENGTH !== 0) return null;
  if (value.length / LIST_SYNC_HASH_LENGTH > LIST_SYNC_MAX_KNOWN) return null;
  if (!VERSION_ALPHABET.test(value)) return null;
  const versions: string[] = [];
  for (let offset = 0; offset < value.length; offset += LIST_SYNC_HASH_LENGTH) {
    versions.push(value.slice(offset, offset + LIST_SYNC_HASH_LENGTH));
  }
  return versions;
}

export function isListSyncPage<T>(value: unknown): value is ListSyncPage<T> {
  if (!value || typeof value !== 'object') return false;
  const page = value as Partial<ListSyncPage<T>>;
  return (
    Array.isArray(page.data) &&
    typeof page.total === 'number' &&
    typeof page.skip === 'number' &&
    !!page.$sync &&
    typeof page.$sync.versions === 'string'
  );
}
