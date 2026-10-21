import type { AgorClient, Artifact, BoardFileItem, Session } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { fetchBoardFiles } from './useBoardFiles';

const REFRESH_DEBOUNCE_MS = 1000;

/**
 * The artifacts and documents a conversation made, archived ones included (they
 * stay as greyed cards), read through the board's Files list so visibility has
 * one source. Not the store: artifact `find()` does not apply the private rule.
 * Reloads when a turn finishes and, debounced, when one of its artifacts changes.
 */
export function useSessionWork(
  client: AgorClient | null,
  session: Pick<Session, 'session_id' | 'status'>,
  boardId: string | null | undefined
): BoardFileItem[] {
  const [state, setState] = useState<{ key: string; items: BoardFileItem[] } | null>(null);
  const key = `${boardId}:${session.session_id}`;
  const [reloads, setReloads] = useState(0);

  // A finished turn may have made something.
  const running = session.status === 'running';
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (wasRunningRef.current && !running) setReloads((n) => n + 1);
    wasRunningRef.current = running;
  }, [running]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloads` asks for a fresh read.
  useEffect(() => {
    if (!client || !boardId) return;
    let cancelled = false;
    fetchBoardFiles(client, boardId, {
      session_id: session.session_id,
      kind: { $in: ['artifact', 'document'] },
      include_archived: true,
      $limit: 50,
    })
      .then((page) => {
        if (!cancelled) setState({ key, items: page.data });
      })
      .catch(() => {
        // Cards are extra; a failed read leaves the transcript as it was.
      });
    return () => {
      cancelled = true;
    };
  }, [client, boardId, session.session_id, key, reloads]);

  useEffect(() => {
    if (!client) return;
    let timer: number | undefined;
    const refresh = (artifact: Partial<Artifact>) => {
      if (artifact?.source_session_id !== session.session_id) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setReloads((n) => n + 1), REFRESH_DEBOUNCE_MS);
    };
    const artifacts = client.service('artifacts');
    for (const event of ['created', 'patched', 'removed']) artifacts.on(event, refresh);
    return () => {
      window.clearTimeout(timer);
      for (const event of ['created', 'patched', 'removed']) {
        artifacts.removeListener(event, refresh);
      }
    };
  }, [client, session.session_id]);

  return state?.key === key ? state.items : NO_WORK;
}

const NO_WORK: BoardFileItem[] = [];

/**
 * Which turn each card follows: the last task that started at or before the
 * item was made. Items older than the first loaded task go to it, unless older
 * turns are still unloaded (they belong to one of those).
 */
export function assignWorkToTasks(
  items: readonly BoardFileItem[],
  tasks: readonly { task_id: string; created_at: string }[],
  { hasOlderTasks = false }: { hasOlderTasks?: boolean } = {}
): Map<string, BoardFileItem[]> {
  const byTask = new Map<string, BoardFileItem[]>();
  if (tasks.length === 0) return byTask;
  const starts = tasks.map((task) => ({ id: task.task_id, at: Date.parse(task.created_at) }));
  const ordered = [...items].sort((a, b) => a.made_at.localeCompare(b.made_at));
  for (const item of ordered) {
    const madeAt = Date.parse(item.made_at);
    let owner: string | undefined;
    for (const start of starts) {
      if (start.at <= madeAt) owner = start.id;
      else break;
    }
    if (!owner && !hasOlderTasks) owner = starts[0].id;
    if (!owner) continue;
    const list = byTask.get(owner) ?? [];
    list.push(item);
    byTask.set(owner, list);
  }
  return byTask;
}
