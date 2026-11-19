// The world a seed built: named handles to the things clips act on (boards,
// branches, sessions...), so specs never hardcode ids or slugs.
//
// Stored as world.json in the scratch workspace, so it travels with every
// checkpoint: restore a seed or a post-<clip> checkpoint and its world comes
// back with it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CastKey } from './cast.ts';
import { SCRATCH_DIR } from './harness.ts';

export const WORLD_FILE = path.join(SCRATCH_DIR, 'world.json');

export interface BoardHandle {
  id: string;
  slug: string;
  /** UI route for the board. */
  path: string;
  /** Zone object ids by the name the seed gave them. */
  zones: Record<string, string>;
}

export interface BranchHandle {
  id: string;
  name: string;
  /** Absolute path of the branch's working directory. */
  dir: string;
  boardId: string;
}

export interface SessionHandle {
  id: string;
  branchId: string;
  title: string;
}

export interface WorldData {
  users: Partial<Record<CastKey, { id: string }>>;
  repos: Record<string, { id: string; slug: string }>;
  boards: Record<string, BoardHandle>;
  branches: Record<string, BranchHandle>;
  sessions: Record<string, SessionHandle>;
  /** Free-form values a seed wants to hand a clip (ids of comments, notes...). */
  extra: Record<string, unknown>;
}

export function emptyWorld(): WorldData {
  return { users: {}, repos: {}, boards: {}, branches: {}, sessions: {}, extra: {} };
}

export class World {
  constructor(readonly data: WorldData) {}

  private pick<T>(kind: keyof Omit<WorldData, 'extra'>, name: string): T {
    const table = this.data[kind] as Record<string, T>;
    const hit = table[name];
    if (!hit) {
      throw new Error(
        `world has no ${kind.replace(/s$/, '')} "${name}" (has: ${Object.keys(table).join(', ') || 'none'}); check the clip's seed`
      );
    }
    return hit;
  }

  board(name: string): BoardHandle {
    return this.pick('boards', name);
  }
  branch(name: string): BranchHandle {
    return this.pick('branches', name);
  }
  session(name: string): SessionHandle {
    return this.pick('sessions', name);
  }
  user(key: CastKey): { id: string } {
    return this.pick('users', key);
  }
}

export function readWorld(): World {
  if (!existsSync(WORLD_FILE)) return new World(emptyWorld());
  return new World({
    ...emptyWorld(),
    ...(JSON.parse(readFileSync(WORLD_FILE, 'utf8')) as WorldData),
  });
}

export function writeWorld(world: World): void {
  writeFileSync(WORLD_FILE, `${JSON.stringify(world.data, null, 2)}\n`);
}
