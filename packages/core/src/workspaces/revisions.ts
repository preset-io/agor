import path from 'node:path';
import { equal, validateTree } from './tree';
import type { CommitOutcome, Mutation, ToolTicket, Tree, WorkspaceState } from './types';

/** Pure optimistic validation; the caller holds the branch SQL row lock. */
export function applyWorkspaceMutations(
  s: WorkspaceState,
  ticket: ToolTicket,
  changes: Mutation[],
  exclude: string[]
): CommitOutcome {
  const conflicts = changes.filter(
    (c) => (s.versions[c.path] ?? 0) > ticket.baseRevision || !equal(c.before, s.tree[c.path])
  );
  // Changing/removing a directory conflicts with any subsequently changed descendant.
  for (const c of changes)
    if (
      c.before?.kind === 'directory' &&
      c.after?.kind !== 'directory' &&
      Object.entries(s.versions).some(
        ([p, v]) => p.startsWith(`${c.path}/`) && v > ticket.baseRevision
      ) &&
      !conflicts.includes(c)
    )
      conflicts.push(c);
  // Ancestor replacements also conflict with a concurrently created child.
  for (const c of changes) {
    let parent = path.posix.dirname(c.path);
    while (parent !== '.') {
      if (
        (s.versions[parent] ?? 0) > ticket.baseRevision &&
        !changes.some((m) => m.path === parent) &&
        s.tree[parent]?.kind !== 'directory' &&
        !conflicts.includes(c)
      )
        conflicts.push(c);
      parent = path.posix.dirname(parent);
    }
  }
  let outcome: CommitOutcome;
  if (conflicts.length) {
    outcome = {
      status: 'conflict',
      baseRevision: ticket.baseRevision,
      currentRevision: s.revision,
      executorId: ticket.executorId,
      toolId: ticket.toolId,
      paths: conflicts.map((c) => ({
        path: c.path,
        operation: c.operation,
        baseHash: c.before?.hash ?? null,
        currentHash: s.tree[c.path]?.hash ?? null,
        proposedHash: c.after?.hash ?? null,
      })),
    };
  } else {
    const tree: Tree = Object.assign(Object.create(null), s.tree);
    for (const c of changes) {
      if (c.after) tree[c.path] = c.after;
      else delete tree[c.path];
    }
    validateTree(tree, exclude);
    if (changes.length) {
      s.revision++;
      for (const c of changes) s.versions[c.path] = s.revision;
      s.tree = tree;
    }
    outcome = { status: 'committed', revision: s.revision };
  }
  return outcome;
}
