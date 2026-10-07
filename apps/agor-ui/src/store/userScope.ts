/**
 * User scope: everything Home and the teammates surfaces read, loaded in full
 * for the caller (`context/explorations/user-first-scoped-hydration.md`).
 *
 * - Gated (in `useAgorData`'s first paint): my newest `MY_SESSIONS_GATED_LIMIT`
 *   sessions. Fewer rows than the limit already means "all of mine".
 * - U1: all of my active sessions in ONE read (no offset pages: an archive
 *   during a paged read shifts rows and skips one), capped at
 *   `MY_SESSIONS_FULL_LIMIT`; hitting the cap commits an incomplete piece.
 * - U2: my branches (`branches{created_by}`).
 * - U3: every marker teammate branch I can view (`branches{teammate: true}`),
 *   capped at `PAGINATION.MAX_TEAMMATE_BRANCHES`; the daemon's real total
 *   sets an incomplete piece when the cap was hit.
 * - U5: every branch my sessions or candidate comment threads reference that
 *   is still absent, read by id in chunks; ids the server does not return go
 *   into `absentBranchIds` (archived, deleted or invisible).
 *
 * Fork ancestors of other users are deliberately NOT fetched (decision Q4,
 * 2026-10-01); see `startedByUserLineage` in `homeSelectors.ts`.
 *
 * Every read applies with the fill-only merge and per-id touched fence
 * (`applyEntityFill`), under the lifetime of the load that started the run.
 * A reconnect run (`replace`) reconciles instead: U1, U2 and U3 apply as
 * complete replaces of their piece (`replaceScope`), so rows deleted, archived
 * or moved out while disconnected leave, unless another scope's committed
 * membership holds them; a capped read removes nothing. Once they settled it
 * re-reads every referenced branch, present ones too, by id: a chunk's
 * omitted ids leave the same way and become absent.
 * U1, U2 and U3 each commit a coverage entry (`USER_SCOPE_KEYS`) in the update
 * that applies their rows, with the run's generation, their membership
 * (`settledMembers`, then kept live by realtime) and whether the read was
 * capped. The referenced-branch piece commits no members: they are derived
 * (`referenceMembers`). The readiness flags Home and the teammate surfaces
 * read are selectors over those entries. An entry stays loaded across runs
 * within one identity (`resetMaps` clears it), so nothing flickers on a
 * reconnect; until the new run commits, its members are stale and keep no row
 * alive. A failed U1/U2/U3 read leaves its piece unloaded
 * (Home keeps its loading state) until the next run, which `useAgorData`
 * starts again on every silent reconnect resync.
 *
 * Realtime keeps the scope complete for rows; a store subscription, installed
 * before the first read, keeps it complete for new REFERENCES (a new session of
 * mine, a new comment thread on a branch that isn't loaded) by ensuring their
 * branches: debounced, through the run's id reader (`idReads.ts`: chunks,
 * bounded concurrency, capped-backoff retries). Absent marks are revalidated
 * at the start of every run.
 */
import type { AgorClient, BoardComment, Branch, Session } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { getTimeMs } from '../utils/entityTime';
import { fencedRead, RESTART_READ } from './agorHydration';
import { applyEntityFill, type DataMaps } from './agorMaps';
import { type AgorState, agorStore, type LoadMetaUpdate } from './agorStore';
import { createIdReader, type IdReader, rowsOf } from './idReads';
import {
  authorityIdentity,
  captureLoadLifetime,
  isLoadLifetimeCurrent,
  type LoadLifetime,
} from './loadLifetime';
import { getRealtimeAuthorityScope } from './realtimeBatch';
import { admitHeld, type RowHold } from './retention';
import { pinnedMembers } from './rowPins';
import {
  BOARD_SCOPE_PREFIX,
  boardPartitionScope,
  type Coverage,
  type CoverageUpdate,
  type LoadScope,
  type MemberLookup,
  replaceScope,
  type ScopeCoverage,
  type ScopeRows,
  settledMembers,
  USER_SCOPE_KEYS,
  type UserScopeKey,
  userScopePiece,
  withCoverage,
} from './scopeMerge';
import { sessionListQuery } from './sessionListQuery';

/** Gated first-paint page of my sessions. */
export const MY_SESSIONS_GATED_LIMIT = 200;
/** Cap of the single all-my-sessions read (U1). */
export const MY_SESSIONS_FULL_LIMIT = PAGINATION.MAX_LIMIT;
/** Debounce for ensuring branches of newly referenced ids. */
const REFERENCE_DEBOUNCE_MS = 100;

/** The newest-first query for my active sessions. */
export function mySessionsQuery(userId: string, limit: number) {
  return sessionListQuery({
    created_by: userId,
    archived: false,
    $sort: { updated_at: -1 },
    $limit: limit,
    $count: false,
  });
}

const loadedPiece = (s: Pick<AgorState, 'coverage'>, key: UserScopeKey) =>
  s.coverage.get(key)?.status === 'loaded';
const cappedPiece = (s: Pick<AgorState, 'coverage'>, key: UserScopeKey) =>
  s.coverage.get(key)?.complete === false;

/** Every active session the caller created is in `sessionById`. */
export const selectMySessionsLoaded = (s: Pick<AgorState, 'coverage'>) =>
  loadedPiece(s, USER_SCOPE_KEYS.sessions);
/** The all-my-sessions read hit its cap; counts are lower bounds ("N+"). */
export const selectMySessionsTruncated = (s: Pick<AgorState, 'coverage'>) =>
  cappedPiece(s, USER_SCOPE_KEYS.sessions);
/** Every branch my sessions or candidate comment threads reference is present or absent. */
export const selectHomeBranchesLoaded = (s: Pick<AgorState, 'coverage'>) =>
  loadedPiece(s, USER_SCOPE_KEYS.references);
/** The teammate read finished; with `selectTeammatesTruncated`, only up to its cap. */
export const selectTeammatesLoaded = (s: Pick<AgorState, 'coverage'>) =>
  loadedPiece(s, USER_SCOPE_KEYS.teammates);
/** More teammates are visible than the capped read returned: lists are partial. */
export const selectTeammatesTruncated = (s: Pick<AgorState, 'coverage'>) =>
  cappedPiece(s, USER_SCOPE_KEYS.teammates);

/**
 * Branch ids the user scope must resolve: the branch of every active session I
 * created, and of every candidate comment thread — unresolved, on a board that
 * isn't archived, where someone else spoke and the caller did not speak last.
 * A superset of the threads `makeCommentsForYouSelector` can show.
 */
export function referencedBranchIds(
  s: Pick<DataMaps, 'sessionById' | 'commentById' | 'boardById'>,
  userId: string
): Set<string> {
  const ids = new Set<string>();
  for (const session of s.sessionById.values()) {
    if (!session.archived && session.created_by === userId && session.branch_id) {
      ids.add(session.branch_id);
    }
  }
  const threads = new Map<string, BoardComment[]>();
  for (const comment of s.commentById.values()) {
    const rootId = comment.parent_comment_id ?? comment.comment_id;
    const thread = threads.get(rootId);
    if (thread) thread.push(comment);
    else threads.set(rootId, [comment]);
  }
  for (const [rootId, comments] of threads) {
    const root = s.commentById.get(rootId);
    if (!root?.branch_id || root.resolved || s.boardById.get(root.board_id)?.archived) continue;
    let last = root;
    let someoneElse = false;
    for (const comment of comments) {
      if (comment.created_by !== userId) someoneElse = true;
      if (getTimeMs(comment, 'created_at') >= getTimeMs(last, 'created_at')) last = comment;
    }
    if (someoneElse && last.created_by !== userId) ids.add(root.branch_id);
  }
  return ids;
}

/**
 * The referenced-branch piece's membership: every present (active) branch my
 * sessions or candidate comment threads reference now, however it loaded (a
 * partition, an event, U5). A branch no longer referenced leaves it.
 */
export function referenceMembers(
  s: Pick<DataMaps, 'sessionById' | 'commentById' | 'boardById' | 'branchById'>,
  userId: string
): Set<string> {
  const members = referencedBranchIds(s, userId);
  for (const id of members) if (!s.branchById.has(id)) members.delete(id);
  return members;
}

/**
 * The memberships a replace of `exceptKey` must respect: every other scope
 * loaded under the current lifetime (a row that belongs to one of them is
 * never removed) and the pinned rows (`rowPins.ts`). Loading, failed and stale scopes (another authority or
 * lifetime) hold nothing, unless `stale` (an eviction, which only frees
 * memory, keeps what a scope from an earlier lifetime still describes until
 * its next commit). Overlapping scopes are normal: my session on a loaded
 * board belongs to the user scope and to that partition.
 */
export function otherCommittedMembers(
  state: AgorState,
  exceptKey?: string,
  { stale = false }: { stale?: boolean } = {}
): MemberLookup[] {
  const members: MemberLookup[] = [];
  for (const [key, entry] of state.coverage) {
    if (key === exceptKey || entry.status !== 'loaded') continue;
    if (!stale && !isLoadLifetimeCurrent(entry)) continue;
    if (key === USER_SCOPE_KEYS.references && entry.userId) {
      members.push({ branches: referenceMembers(state, entry.userId) });
    } else if (entry.members) {
      members.push(entry.members);
    }
  }
  members.push(pinnedMembers);
  return members;
}

/**
 * The scopes a row entering the store may belong to (`admitHeld`): every
 * board partition loading or loaded under the current lifetime, and the
 * caller's user scope — every load of the authority starts it — with the
 * branches its references name judged on the maps the row enters.
 */
export function joinableScopes(coverage: Coverage): LoadScope[] {
  const scopes: LoadScope[] = [];
  for (const [key, entry] of coverage) {
    if (!key.startsWith(BOARD_SCOPE_PREFIX) || entry.status === 'error') continue;
    if (isLoadLifetimeCurrent(entry)) {
      scopes.push(boardPartitionScope(key.slice(BOARD_SCOPE_PREFIX.length)));
    }
  }
  const authority = getRealtimeAuthorityScope();
  if (!authority) return scopes;
  const userId = authorityIdentity(authority);
  let referenced: { maps: DataMaps; ids: Set<string> } | null = null;
  scopes.push(
    userScopePiece(USER_SCOPE_KEYS.sessions, userId),
    userScopePiece(USER_SCOPE_KEYS.branches, userId),
    userScopePiece(USER_SCOPE_KEYS.teammates, userId),
    {
      key: USER_SCOPE_KEYS.references,
      claims: {
        branches: (branch, maps) => {
          if (referenced?.maps !== maps) {
            referenced = { maps, ids: referencedBranchIds(maps, userId) };
          }
          return referenced.ids.has(branch.branch_id);
        },
      },
    }
  );
  return scopes;
}

interface ScopeRun {
  client: AgorClient;
  userId: string;
  /** The lifetime of the load that started the run; never the current one. */
  lifetime: LoadLifetime;
  /** The coverage generation of every piece this run commits. */
  generation: number;
  /** The referenced-branch reads; ids that failed every attempt wait for the next run. */
  ids: IdReader;
  /** Every reference is known: my sessions (U1 or a complete gated page) and my branches (U2) loaded. */
  referencesKnown: boolean;
  /** A reconnect run: every read reconciles its scope instead of filling it. */
  replace: boolean;
  referenceTimer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
}

let currentRun: ScopeRun | null = null;
let runSequence = 0;

const isCurrent = (run: ScopeRun) => currentRun === run && isLoadLifetimeCurrent(run.lifetime);

export type FillRows = { branches?: Branch[]; sessions?: Session[] };

/**
 * Read rows and fill-merge them (`fencedRead`); null once `current` turns
 * false. Read errors propagate, and so does a read whose every attempt
 * spanned a wholesale replacement: its snapshot is never applied.
 *
 * With `piece`, the read commits that piece in the update that applies its
 * rows; with `commitIf`, the rows apply at once and the piece commits once it
 * resolves true (false resolves null); a deferred replace applies its rows
 * only then, with the coverage. Its membership is the rows it returned,
 * with the rows realtime wrote meanwhile judged by their current value
 * (`settledMembers`). With `replace`, the rows reconcile that scope
 * (`replaceScope`, complete unless the piece says the read was capped) instead
 * of filling it. `meta` publishes load meta with the rows (absent marks).
 */
async function fillRead(
  current: () => boolean,
  read: () => Promise<FillRows>,
  options: {
    piece?: {
      run: ScopeRun;
      key: UserScopeKey;
      complete: (rows: FillRows) => boolean;
      commitIf?: () => Promise<boolean>;
    };
    replace?: LoadScope;
    meta?: (rows: FillRows) => LoadMetaUpdate;
    /** An on-demand fill: rows pinned in `hold`, if any, and only held rows inserted. */
    onDemand?: { hold?: RowHold };
  } = {}
): Promise<FillRows | null> {
  const { piece, replace, onDemand } = options;
  return fencedRead(
    read,
    async (rows, fence) => {
      const complete = piece ? piece.complete(rows) : true;
      const settle: CoverageUpdate | undefined =
        piece &&
        ((maps, coverage) =>
          withCoverage(
            coverage,
            piece.key,
            pieceEntry(piece.run, {
              status: 'loaded',
              members: settledMembers(
                userScopePiece(piece.key, piece.run.userId),
                rows as ScopeRows,
                maps,
                fence.touchedIds
              ),
              complete,
            })
          ));
      let update = (prev: DataMaps) =>
        replace
          ? replaceScope(
              prev,
              replace,
              { ...rows, complete },
              fence.touched,
              otherCommittedMembers(agorStore.getState(), replace.key)
            )
          : applyEntityFill(prev, rows, fence.touched);
      let meta = options.meta?.(rows);
      if (onDemand) {
        const ids = {
          sessions: rows.sessions?.map((session) => session.session_id),
          branches: rows.branches?.map((branch) => branch.branch_id),
        };
        onDemand.hold?.pin(ids);
        const fill = update;
        update = (prev) => admitHeld(prev, fill(prev), ids);
      }
      if (piece?.commitIf && replace) {
        // A deferred reconcile applies its rows and coverage together once
        // allowed: applied earlier, its removals would be judged against the
        // memberships of the very pieces it waits for (a branch both pieces
        // hold would survive each one's replace through the other's old one).
        if (!(await piece.commitIf()) || !current()) return null;
        if (fence.replaced()) return RESTART_READ;
      } else if (piece?.commitIf) {
        // A deferred fill publishes the rows now and the coverage once allowed.
        agorStore.getState().applyMaps(update, undefined, meta);
        if (!(await piece.commitIf()) || !current()) return null;
        update = (prev) => prev;
        meta = undefined;
      }
      agorStore.getState().applyMaps(update, settle, meta);
      return rows;
    },
    current
  );
}

/**
 * Read rows on demand — search results, a deep link's target, the rows a
 * view ensures — and fill-merge them under the current load lifetime. They
 * join no scope: a row is inserted only while something holds it
 * (`admitHeld`) — the consumer's pins, taken before the read, or `hold`,
 * which pins every returned row as it applies. Null without an authority,
 * once the lifetime ends or once `hold` is released: a reply that outlives
 * its consumer inserts nothing. Read errors propagate.
 */
export async function fillOnDemand(
  read: () => Promise<FillRows>,
  hold?: RowHold
): Promise<FillRows | null> {
  const lifetime = captureLoadLifetime();
  if (!lifetime) return null;
  return fillRead(() => isLoadLifetimeCurrent(lifetime) && !hold?.released, read, {
    onDemand: { hold },
  });
}

/** A piece's coverage entry under `run`'s lifetime and generation. */
function pieceEntry(
  run: ScopeRun,
  entry: Pick<ScopeCoverage, 'status' | 'members' | 'complete'>
): ScopeCoverage {
  return { ...entry, ...run.lifetime, generation: run.generation, userId: run.userId };
}

/** Commit one piece's coverage under `run`'s lifetime (current run only). */
function commitPiece(
  run: ScopeRun,
  key: UserScopeKey,
  entry: Pick<ScopeCoverage, 'status' | 'members' | 'complete'>
): void {
  if (!isCurrent(run)) return;
  agorStore.getState().setCoverage(key, pieceEntry(run, entry));
}

/**
 * Mark the referenced-branch piece loaded. Its membership is derived
 * (`referenceMembers`), so it commits none.
 */
function settleReferencePiece(run: ScopeRun): void {
  commitPiece(run, USER_SCOPE_KEYS.references, { status: 'loaded' });
}

/** Ids of my active sessions in the store. */
function mySessionIds(s: AgorState, userId: string): Set<string> {
  const ids = new Set<string>();
  for (const session of s.sessionById.values()) {
    if (!session.archived && session.created_by === userId) ids.add(session.session_id);
  }
  return ids;
}

/** `absent` plus `add`, without the branches present in `branchById`; itself when unchanged. */
function withAbsent(
  absent: Set<string>,
  add: readonly string[],
  branchById: DataMaps['branchById']
): Set<string> {
  const next = new Set([...absent, ...add]);
  for (const id of next) if (branchById.has(id)) next.delete(id);
  const same = next.size === absent.size && [...next].every((id) => absent.has(id));
  return same ? absent : next;
}

/**
 * Add absent marks and drop the marks of branches that are present now, or
 * that nothing references any more: the marks follow current references, not
 * history (current run only).
 */
function updateAbsent(run: ScopeRun, add: readonly string[]): void {
  if (!isCurrent(run)) return;
  const state = agorStore.getState();
  let absentBranchIds = withAbsent(state.absentBranchIds, add, state.branchById);
  const referenced = referencedBranchIds(state, run.userId);
  if ([...absentBranchIds].some((id) => !referenced.has(id))) {
    absentBranchIds = new Set([...absentBranchIds].filter((id) => referenced.has(id)));
  }
  if (absentBranchIds !== state.absentBranchIds) state.setUserScope({ absentBranchIds });
}

/** Ids referenced but neither present, absent, nor pending or failed in this run. */
function missingReferences(s: AgorState, run: ScopeRun): string[] {
  const missing: string[] = [];
  for (const id of referencedBranchIds(s, run.userId)) {
    if (
      !s.branchById.has(id) &&
      !s.absentBranchIds.has(id) &&
      !run.ids.pending.has(id) &&
      !run.ids.failed.has(id)
    ) {
      missing.push(id);
    }
  }
  return missing;
}

/** The referenced-branch piece is loaded once every reference is known and none is unresolved. */
function settleHomeBranches(run: ScopeRun): void {
  if (!isCurrent(run) || !run.referencesKnown) return;
  if (run.ids.pending.size > 0 || run.ids.failed.size > 0) return;
  if (missingReferences(agorStore.getState(), run).length > 0) return;
  settleReferencePiece(run);
}

/**
 * Read one chunk of branch ids and record the ones the server doesn't return —
 * and that didn't arrive meanwhile — as absent, in the update that applies the
 * chunk's rows. In a replace run the chunk reconciles its ids: returned rows
 * overwrite, omitted ones leave unless another scope's committed membership
 * holds them. A failed read is retried by the run's reader (`idReads.ts`).
 */
async function readBranchChunk(run: ScopeRun, chunk: string[]): Promise<Set<string> | null> {
  const requested = new Set(chunk);
  const replace: LoadScope | undefined = run.replace
    ? {
        key: USER_SCOPE_KEYS.references,
        claims: { branches: (branch) => requested.has(branch.branch_id) },
      }
    : undefined;
  const rows = await fillRead(
    () => isCurrent(run),
    async () => ({
      branches: rowsOf<Branch>(
        await run.client.service('branches').find({
          query: { branch_id: { $in: chunk }, archived: false, $limit: chunk.length },
        })
      ),
    }),
    {
      replace,
      meta: ({ branches }) => {
        const returned = new Set((branches ?? []).map((branch) => branch.branch_id as string));
        const omitted = chunk.filter((id) => !returned.has(id));
        return (maps, state) => ({
          absentBranchIds: withAbsent(state.absentBranchIds, omitted, maps.branchById),
        });
      },
    }
  );
  return rows && new Set((rows.branches ?? []).map((branch) => branch.branch_id as string));
}

/** Clear marks of branches that arrived, queue new references, and settle. */
function checkReferences(run: ScopeRun): void {
  if (!isCurrent(run)) return;
  // A branch arriving by any path (event, partition, ensure) clears its mark.
  updateAbsent(run, []);
  run.ids.queue(missingReferences(agorStore.getState(), run));
  settleHomeBranches(run);
}

function scheduleReferenceCheck(run: ScopeRun): void {
  if (run.referenceTimer) return;
  run.referenceTimer = setTimeout(() => {
    run.referenceTimer = null;
    checkReferences(run);
  }, REFERENCE_DEBOUNCE_MS);
}

function subscribeToReferences(run: ScopeRun): void {
  run.unsubscribe = agorStore.subscribe((state, prev) => {
    if (
      state.sessionById === prev.sessionById &&
      state.commentById === prev.commentById &&
      state.branchById === prev.branchById
    ) {
      return;
    }
    scheduleReferenceCheck(run);
  });
}

/** The generation of the user scope run in progress under the current lifetime, if any. */
export function userScopeRunGeneration(): number | null {
  return currentRun && isCurrent(currentRun) ? currentRun.generation : null;
}

/** Stop the current run: unsubscribe, cancel its timers, and drop its pending applies. */
export function stopUserScope(): void {
  const run = currentRun;
  currentRun = null;
  if (!run) return;
  run.unsubscribe?.();
  run.unsubscribe = null;
  if (run.referenceTimer) clearTimeout(run.referenceTimer);
  run.referenceTimer = null;
  run.ids.dispose();
}

/**
 * Load the user scope under `lifetime`, the lifetime of the load that started
 * it (captured before that load's first await). A lifetime that is no longer
 * current — another authority, or a cancellation since — is rejected, so a
 * load that outlived a logout/remount can never adopt the next user's
 * authority. `gatedMineComplete` says the gated first-paint page already holds
 * all of my active sessions (it returned fewer than `MY_SESSIONS_GATED_LIMIT`
 * rows and raced none of mine), so U1 can be skipped. Resolves when the
 * initial reads and the id reads they triggered settled, failed, or were
 * superseded; the reference subscription and retries keep running until
 * `stopUserScope`.
 */
export async function startUserScope(
  client: AgorClient,
  options: {
    userId: string;
    lifetime: LoadLifetime;
    gatedMineComplete: boolean;
    /**
     * Hold the bulk U1 read until this settles: on a session route, the opened
     * transcript (#2887's transcript-first barrier). The small reads (U2, U3,
     * referenced branches) never wait for it.
     */
    deferBulkRead?: Promise<void>;
    /** A reconnect resync: reconcile every piece instead of filling it. */
    replace?: boolean;
  }
): Promise<void> {
  if (!isLoadLifetimeCurrent(options.lifetime)) return;
  stopUserScope();
  const run: ScopeRun = {
    client,
    userId: options.userId,
    lifetime: options.lifetime,
    generation: ++runSequence,
    ids: createIdReader({
      read: (chunk) => readBranchChunk(run, chunk),
      isCurrent: () => isCurrent(run),
      onChange: () => settleHomeBranches(run),
      // A fill run reads again only what is still missing.
      retry: (ids) => ids.filter((id) => run.replace || !agorStore.getState().branchById.has(id)),
    }),
    referencesKnown: false,
    replace: options.replace ?? false,
    referenceTimer: null,
    unsubscribe: null,
  };
  currentRun = run;
  const store = () => agorStore.getState();
  const reconcile = (key: UserScopeKey) =>
    run.replace ? userScopePiece(key, run.userId) : undefined;
  if (options.gatedMineComplete) {
    commitPiece(run, USER_SCOPE_KEYS.sessions, {
      status: 'loaded',
      members: { sessions: mySessionIds(store(), run.userId) },
      complete: true,
    });
  }

  // A replace run re-reads the branches referenced before it, too: one may
  // lose its last reference when U1 removes a session, and nothing else
  // would read it again.
  const startReferences = run.replace ? referencedBranchIds(store(), run.userId) : null;
  // Subscribe before any read: a reference that appears while the reads below
  // are in flight is seen by the subscription, never lost between a scan and
  // a late subscribe.
  subscribeToReferences(run);
  // Absent marks are negatives of the authority that produced them (a grant,
  // reconnect or role change can make a branch visible): revalidate them.
  run.ids.queue(store().absentBranchIds);
  // Early pass: resolve what the gated page already references now — full
  // page or not — so these small reads go out before U1 instead of queuing
  // behind it on a slow socket.
  checkReferences(run);

  // Small reads first (U2, U3), then the bulk U1: on a slow socket the
  // teammate and branch answers then don't queue behind thousands of rows.
  const u2 = fillRead(
    () => isCurrent(run),
    async () => ({
      branches: rowsOf<Branch>(
        await client.service('branches').findAll({
          query: { created_by: run.userId, archived: false, $limit: PAGINATION.DEFAULT_LIMIT },
        })
      ),
    }),
    {
      piece: { run, key: USER_SCOPE_KEYS.branches, complete: () => true },
      replace: reconcile(USER_SCOPE_KEYS.branches),
    }
  ).then((rows) => !!rows);
  // The daemon reports the real total, so a capped read is never "all teammates".
  let teammateTotal = 0;
  const u3 = fillRead(
    () => isCurrent(run),
    async () => {
      const result = await client.service('branches').find({
        query: { teammate: true, archived: false, $limit: PAGINATION.MAX_TEAMMATE_BRANCHES },
      });
      const branches = rowsOf<Branch>(result);
      const total = (result as { total?: unknown }).total;
      teammateTotal = typeof total === 'number' ? total : branches.length;
      return { branches };
    },
    {
      piece: {
        run,
        key: USER_SCOPE_KEYS.teammates,
        complete: (rows) => teammateTotal <= (rows.branches?.length ?? 0),
        // Commit U3 once U2 committed. A reconnect's replace applies its rows
        // only then too, so neither replace judges removals against the
        // other's previous membership.
        commitIf: () => u2.catch(() => false),
      },
      replace: reconcile(USER_SCOPE_KEYS.teammates),
    }
  ).then((rows) => !!rows);

  const u1 = options.gatedMineComplete
    ? Promise.resolve(true)
    : fillRead(
        () => isCurrent(run),
        async () => {
          // Await only a real barrier: even `await undefined` would send U1 a
          // microtask late.
          if (options.deferBulkRead) {
            await options.deferBulkRead;
            if (!isCurrent(run)) return {};
          }
          return {
            sessions: rowsOf<Session>(
              await client
                .service('sessions')
                .find({ query: mySessionsQuery(run.userId, MY_SESSIONS_FULL_LIMIT) })
            ),
          };
        },
        {
          piece: {
            run,
            key: USER_SCOPE_KEYS.sessions,
            complete: (rows) => (rows.sessions?.length ?? 0) < MY_SESSIONS_FULL_LIMIT,
          },
          replace: reconcile(USER_SCOPE_KEYS.sessions),
        }
      ).then((rows) => !!rows);

  const settled = await Promise.allSettled([u1, u2, u3]);
  if (!isCurrent(run)) return;
  for (const result of settled) {
    if (result.status === 'rejected') console.warn('[userScope] read failed:', result.reason);
  }
  // Every reference is known once all of my sessions and my branches are in;
  // teammates (U3) only shrink the id list, so they needn't succeed.
  const ok = (index: number) => settled[index].status === 'fulfilled' && settled[index].value;
  if (ok(0) && ok(1)) run.referencesKnown = true;
  if (startReferences) {
    // After U1-U3 applied, so no piece replace runs after a chunk and keeps a
    // row through a reference that is gone. Missing ids are already queued.
    const state = store();
    const present = [...startReferences, ...referencedBranchIds(state, run.userId)];
    run.ids.queue(present.filter((id) => state.branchById.has(id)));
  }
  // Immediate catch-up scan (not debounced), even when U1 or U2 failed: the
  // references a read that did land added are queued now. Resolve only once
  // those follow-up id reads settle. Completeness (the referenced-branch
  // piece) still needs referencesKnown.
  checkReferences(run);
  await run.ids.drained();
}
