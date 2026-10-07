import type { AgorClient, Branch, Session } from '@agor-live/client';
import { useRef } from 'react';
import { rowsOf } from '@/store/idReads';
import { useServerRead } from '../../hooks/useServerRead';

type Listener = (row: Branch) => void;
type Page = { rows: Branch[]; total: number };

const NO_PAGE: Page = { rows: [], total: 0 };

/**
 * One page of `branches.find(query)`, newest first, and the server's total,
 * for a settings table that pages on the daemon rather than over the store
 * (which holds only the loaded scopes). The rows are local display state:
 * they never enter the store and join no scope. Read through `useServerRead`:
 * a patch to a row on the page replaces it in place (and survives a re-read
 * in flight); an event that can change the page's membership or total — a
 * create, a removal, an archive flip, a patch to an off-page row under a
 * filter, any patch while searching — reads the page again, debounced.
 * `query: null` reads nothing.
 */
export function useBranchPage(
  client: AgorClient | null,
  query: Record<string, unknown> | null,
  page: number,
  pageSize: number
): { rows: Branch[]; total: number; loading: boolean; refresh: () => void } {
  // A stable key for an inline query object.
  const queryKey = query ? JSON.stringify(query) : null;
  const rowsRef = useRef<Branch[]>([]);
  const { data, loading, refresh } = useServerRead<Page>(
    client,
    queryKey && `${queryKey}|${page}|${pageSize}`,
    async (client) => {
      const found = await client.service('branches').find({
        query: {
          ...JSON.parse(queryKey as string),
          $limit: pageSize,
          $skip: (page - 1) * pageSize,
          $sort: { created_at: -1 },
        },
      });
      const rows = rowsOf<Branch>(found);
      return { rows, total: Array.isArray(found) ? rows.length : found.total };
    },
    {
      keepPrevious: true,
      subscribe: (client, { invalidate, patch }) => {
        const service = client.service('branches');
        const searching = query?.search !== undefined;
        // Under a filter, an off-page patch may be an archive flip or a match.
        const filtered = searching || query?.archived !== undefined;
        const patched: Listener = (branch) => {
          const row = rowsRef.current.find((r) => r.branch_id === branch.branch_id);
          if (row ? searching || row.archived !== branch.archived : filtered) invalidate();
          if (!row) return;
          patch((prev) => ({
            ...prev,
            rows: prev.rows.map((r) => (r.branch_id === branch.branch_id ? branch : r)),
          }));
        };
        service.on('created', invalidate);
        service.on('patched', patched);
        service.on('removed', invalidate);
        return () => {
          service.off('created', invalidate);
          service.off('patched', patched);
          service.off('removed', invalidate);
        };
      },
    }
  );
  const result = data ?? NO_PAGE;
  rowsRef.current = result.rows;
  return { ...result, loading, refresh };
}

/** What of a session decides which count it falls in; a field a patch omitted is unknown. */
type CountFields = Partial<Pick<Session, 'branch_id' | 'branch_board_id' | 'archived'>>;
const COUNT_FIELDS = ['branch_id', 'branch_board_id', 'archived'] as const;
const countKey = (s: CountFields) => `${s.archived}|${s.branch_id}|${s.branch_board_id}`;
/** `known` with the count fields `patch` supplies (a patch may carry only some). */
function mergeCountFields(known: CountFields | undefined, patch: Partial<Session>): CountFields {
  const next: CountFields = { ...known };
  for (const field of COUNT_FIELDS) {
    if (field in patch) (next as Record<string, unknown>)[field] = patch[field];
  }
  return next;
}

const NO_COUNTS = new Map<string, number>();

/**
 * Active sessions per `field` value (a branch or a board), read as count-only
 * pages (`$limit: 0`) for just the ids a table shows, since the store holds
 * only the loaded scopes' sessions. Read through `useServerRead`: counted
 * again after an event that can change a shown count — a session create or
 * removal, a session's archive flip or branch/board change, a branch's move
 * between boards (board counts) — and after an authority change, but not
 * after a value-only patch (status, title). Events may carry only some
 * fields: per session it remembers just the count fields they supplied
 * (`branch_id`, `branch_board_id`, `archived`) and merges each patch into
 * them, and per branch its board; one whose membership is still unknown
 * counts again once. Display only; an id missing from the map has no count
 * yet.
 */
export function useSessionCounts(
  client: AgorClient | null,
  field: 'branch_id' | 'board_id',
  ids: string[]
): Map<string, number> {
  const idsKey = ids.join(',');
  const { data } = useServerRead(
    client,
    idsKey ? `${field}|${idsKey}` : null,
    async (client) => {
      const counts = new Map<string, number>();
      await Promise.all(
        idsKey.split(',').map(async (id) => {
          const found = await client
            .service('sessions')
            .find({ query: { [field]: id, archived: false, $limit: 0 } });
          if (!Array.isArray(found)) counts.set(id, found.total);
        })
      );
      return counts;
    },
    {
      keepPrevious: true,
      subscribe: (client, { invalidate }) => {
        const shown = new Set(idsKey.split(','));
        // An unknown field may hold a shown id.
        const shows = (s: CountFields) =>
          field === 'board_id'
            ? s.branch_board_id === undefined || shown.has(s.branch_board_id ?? '')
            : s.branch_id === undefined || shown.has(s.branch_id);
        // Per session, only the count fields events supplied; per branch, its board.
        const known = new Map<string, CountFields>();
        const boards = new Map<string, string | null | undefined>();
        const sessionAdded = (session: Session) => {
          known.set(session.session_id, mergeCountFields(undefined, session));
          if (shows(known.get(session.session_id)!)) invalidate();
        };
        const sessionRemoved = (session: Session) => {
          const fields = mergeCountFields(known.get(session.session_id), session);
          known.delete(session.session_id);
          if (shows(fields)) invalidate();
        };
        const sessionPatched = (patch: Session) => {
          // A value-only patch (status, title) can't move a count.
          if (!COUNT_FIELDS.some((f) => f in patch)) return;
          const prev = known.get(patch.session_id);
          const next = mergeCountFields(prev, patch);
          known.set(patch.session_id, next);
          // Unknown membership: count again, conservatively.
          if (!prev) return invalidate();
          if (countKey(prev) === countKey(next)) return;
          if (shows(prev) || shows(next)) invalidate();
        };
        const branchPatched = (branch: Branch) => {
          if (!('board_id' in branch)) return;
          const unknown = !boards.has(branch.branch_id);
          const prev = boards.get(branch.branch_id);
          boards.set(branch.branch_id, branch.board_id);
          if (unknown || prev !== branch.board_id) invalidate();
        };
        const sessions = client.service('sessions');
        const branches = client.service('branches');
        sessions.on('created', sessionAdded);
        sessions.on('patched', sessionPatched);
        sessions.on('removed', sessionRemoved);
        if (field === 'board_id') {
          branches.on('patched', branchPatched);
          branches.on('removed', invalidate);
        }
        return () => {
          sessions.off('created', sessionAdded);
          sessions.off('patched', sessionPatched);
          sessions.off('removed', sessionRemoved);
          branches.off('patched', branchPatched);
          branches.off('removed', invalidate);
        };
      },
    }
  );
  return data ?? NO_COUNTS;
}
