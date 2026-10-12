// Seeding primitives: build workspace state off camera through the daemon's
// own REST API (the same calls the UI and CLI make), so a clip opens on a
// lived-in workspace without filming the setup.
//
// Everything goes through real services with real permission checks, and
// branches are real git branches with real working directories. The one
// thing REST can't fake is a finished agent conversation; prompt() runs a
// real turn instead (through the cassette proxy, so it can be replayed).
//
// Each primitive records what it made in the World (world.ts) under the
// name you give it, which is how clips find things later.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AgorApi } from './api.ts';
import { CAST, CAST_KEYS, type CastKey } from './cast.ts';
import { DEMO_REPO_DEFAULT_BRANCH, PROXY_URL, resolveAgentMode, SECRETS_FILE } from './harness.ts';
import type { BoardHandle, BranchHandle, SessionHandle, World } from './world.ts';

/** A zone as the board stores it (packages/core/src/types/board.ts). */
export interface ZoneSpec {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Border color; the fill is the same color at 10% opacity. */
  color?: string;
  /** Handlebars prompt that fires when a branch is dropped in the zone. */
  trigger?: { template: string; behavior?: 'show_picker' | 'always_new'; agent?: string };
}

export interface BranchSpec {
  /** Git branch name (also the card title). */
  name: string;
  repo: string;
  board: string;
  /** Zone name (a key of the board's zones); position is then relative to the zone. */
  zone?: string;
  at?: { x: number; y: number };
  /** Branch to start from (default: the repo's default branch). */
  from?: string;
  as?: CastKey;
  notes?: string;
}

const AGENT_MODELS: Record<string, string> = { 'claude-code': 'claude-sonnet-4-5' };

function secret(name: string): string | null {
  if (!existsSync(SECRETS_FILE)) return null;
  for (const line of readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
    if (line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim();
  }
  return null;
}

async function poll<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs: number,
  everyMs = 1000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export class Seeder {
  private readonly apis = new Map<CastKey, AgorApi>();

  constructor(readonly world: World) {}

  /** A REST client signed in as that cast member. */
  async as(key: CastKey = 'sam'): Promise<AgorApi> {
    const hit = this.apis.get(key);
    if (hit) return hit;
    const api = await AgorApi.login(CAST[key].email, CAST[key].password);
    this.apis.set(key, api);
    return api;
  }

  private async userId(key: CastKey): Promise<string> {
    const known = this.world.data.users[key];
    if (known) return known.id;
    const admin = await this.as('sam');
    const rows = await admin.find<{ user_id: string }>('/users', { email: CAST[key].email });
    if (!rows[0]) throw new Error(`no user for ${key} (seed the cast first)`);
    this.world.data.users[key] = { id: rows[0].user_id };
    return rows[0].user_id;
  }

  /**
   * Create the cast's accounts (and rename the bootstrap admin to Sam),
   * with onboarding marked done so nobody lands in the setup wizard.
   */
  async cast(keys: CastKey[] = CAST_KEYS): Promise<void> {
    const admin = await this.as('sam');
    for (const key of keys) {
      const member = CAST[key];
      const existing = await admin.find<{ user_id: string }>('/users', { email: member.email });
      let id = existing[0]?.user_id;
      if (!id) {
        const created = await admin.post<{ user_id: string }>('/users', {
          email: member.email,
          password: member.password,
          name: member.name,
          role: member.role,
          must_change_password: false,
        });
        id = created.user_id;
      } else {
        await admin.patch(`/users/${id}`, { name: member.name });
      }
      this.world.data.users[key] = { id };
      // A user's own row: onboarding_completed is theirs to set.
      const self = await this.as(key);
      await self.patch(`/users/${id}`, { onboarding_completed: true });
    }
  }

  /**
   * Give cast members a working Claude Code connection routed through the
   * cassette proxy (live: a real token from .e2e-secrets; otherwise a
   * placeholder the replay cassette vouches for). Without one, Agor shows
   * "No AI connected" banners on camera.
   */
  async connectAi(keys: CastKey[] = CAST_KEYS): Promise<void> {
    const token =
      resolveAgentMode() === 'live'
        ? (secret('CLAUDE_CODE_OAUTH_TOKEN') ??
          (() => {
            throw new Error(`live mode needs CLAUDE_CODE_OAUTH_TOKEN in ${SECRETS_FILE}`);
          })())
        : 'sk-ant-oat01-replay-placeholder';
    for (const key of keys) {
      const api = await this.as(key);
      const id = await this.userId(key);
      // Base URL first, so the auth probe the token save triggers already
      // goes through the proxy (see agent-settings.ts).
      await api.patch(`/users/${id}`, {
        agentic_tools: { 'claude-code': { ANTHROPIC_BASE_URL: PROXY_URL } },
      });
      await api.patch(`/users/${id}`, {
        agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: token } },
        agentic_auth_methods: { 'claude-code': 'api_key' },
        agentic_credential_sources: { 'claude-code': 'api_key' },
      });
    }
  }

  /** Register a local clone (the demo repo by default) under a name. */
  async repo(name: string, dir: string, slug: string): Promise<void> {
    const admin = await this.as('sam');
    const existing = await admin.find<{ repo_id: string }>('/repos', { slug });
    const repoId =
      existing[0]?.repo_id ??
      (await admin.post<{ repo_id: string }>('/repos/local', { path: dir, slug })).repo_id;
    this.world.data.repos[name] = { id: repoId, slug };
  }

  /**
   * A board, with its zones. `team: true` (the default) makes it a team
   * board: every member can edit it and work on its branches.
   */
  async board(
    name: string,
    spec: {
      title: string;
      icon?: string;
      description?: string;
      zones?: Record<string, ZoneSpec>;
      as?: CastKey;
      team?: boolean;
    }
  ): Promise<BoardHandle> {
    const api = await this.as(spec.as ?? 'sam');
    const zones: Record<string, string> = {};
    const objects: Record<string, unknown> = {};
    for (const [zoneName, z] of Object.entries(spec.zones ?? {})) {
      // Comments anchor to zones by the id after the `zone-` prefix.
      const id = `zone-${zoneName}`;
      zones[zoneName] = id;
      const color = z.color ?? '#1677ff';
      objects[id] = {
        type: 'zone',
        x: z.x,
        y: z.y,
        width: z.width,
        height: z.height,
        label: z.label,
        borderColor: color,
        backgroundColor: `${color}1a`,
        ...(z.trigger ? { trigger: { behavior: 'show_picker', ...z.trigger } } : {}),
      };
    }
    const board = await api.post<{ board_id: string; slug: string }>('/boards', {
      name: spec.title,
      icon: spec.icon,
      description: spec.description,
      objects,
    });
    if (spec.team !== false) await this.shareBoard(board.board_id);
    const handle: BoardHandle = {
      id: board.board_id,
      slug: board.slug,
      path: `/b/${board.slug}/`,
      zones,
    };
    this.world.data.boards[name] = handle;
    return handle;
  }

  /** Let every workspace member edit the board and work on its branches. */
  private async shareBoard(boardId: string): Promise<void> {
    const admin = await this.as('sam');
    type Policies = {
      board_access: { others: { preset: string; capabilities: string[]; fs_access: string } };
      branch_template: {
        access: { others: { preset: string; capabilities: string[]; fs_access: string } };
      };
    };
    const policies = await admin.get<Policies>(`/boards/${boardId}/permissions`);
    policies.board_access.others = {
      ...policies.board_access.others,
      preset: 'editor',
      capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
    };
    // Mirrors capabilityPolicyPresetCapabilities: a work-capable role with
    // filesystem access also gets the terminal.
    const branchOthers = policies.branch_template.access.others;
    branchOthers.preset = 'collaborator';
    branchOthers.capabilities = [
      'branch.view',
      'sessions.create',
      'sessions.prompt_own',
      ...(branchOthers.fs_access !== 'none' ? ['terminal.open'] : []),
    ];
    await admin.patch(`/boards/${boardId}/permissions`, policies);
  }

  /** A real git branch with its own working directory, as a card on a board. */
  async branch(spec: BranchSpec): Promise<BranchHandle> {
    const api = await this.as(spec.as ?? 'sam');
    const repo = this.world.data.repos[spec.repo];
    if (!repo) throw new Error(`branch ${spec.name}: no repo named ${spec.repo}`);
    const board = this.world.board(spec.board);
    const zoneId = spec.zone ? board.zones[spec.zone] : undefined;
    if (spec.zone && !zoneId) throw new Error(`branch ${spec.name}: no zone ${spec.zone}`);
    const created = await api.post<{ branch_id: string }>(`/repos/${repo.id}/branches`, {
      name: spec.name,
      ref: spec.name,
      createBranch: true,
      sourceBranch: spec.from ?? DEMO_REPO_DEFAULT_BRANCH,
      refType: 'branch',
      boardId: board.id,
      ...(spec.at ? { position: spec.at } : {}),
      ...(zoneId ? { zoneId } : {}),
      ...(spec.notes ? { notes: spec.notes } : {}),
    });
    const ready = await poll(
      `branch ${spec.name}`,
      async () => {
        const b = await api.get<{
          filesystem_status?: string;
          error_message?: string;
          path: string;
        }>(`/branches/${created.branch_id}`);
        if (b.filesystem_status === 'failed') {
          throw new Error(`branch ${spec.name} failed: ${b.error_message ?? 'unknown error'}`);
        }
        return b.filesystem_status === 'creating' ? null : b;
      },
      120_000
    );
    const handle: BranchHandle = {
      id: created.branch_id,
      name: spec.name,
      dir: ready.path,
      boardId: board.id,
    };
    this.world.data.branches[spec.name] = handle;
    return handle;
  }

  /**
   * Write files into a branch's working directory and commit them: data for
   * a chart, a half-finished feature, whatever the clip needs to exist.
   */
  commit(branch: string, files: Record<string, string>, message: string): void {
    const b = this.world.branch(branch);
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(b.dir, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const git = (args: string[]) => {
      const res = spawnSync('git', args, { cwd: b.dir, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    };
    git(['add', '--', ...Object.keys(files)]);
    git([
      '-c',
      'user.name=Agor Demo',
      '-c',
      'user.email=demo@agor.live',
      'commit',
      '--quiet',
      '-m',
      message,
    ]);
  }

  /** An agent session on a branch, started by a cast member. */
  async session(
    name: string,
    spec: { branch: string; title: string; as?: CastKey; agent?: string }
  ): Promise<SessionHandle> {
    const api = await this.as(spec.as ?? 'sam');
    const branch = this.world.branch(spec.branch);
    const agent = spec.agent ?? 'claude-code';
    const created = await api.post<{ session_id: string }>('/sessions', {
      branch_id: branch.id,
      agentic_tool: agent,
      title: spec.title,
      status: 'idle',
      ...(AGENT_MODELS[agent]
        ? {
            model_config: {
              mode: 'alias',
              model: AGENT_MODELS[agent],
              updated_at: new Date().toISOString(),
            },
          }
        : {}),
    });
    const handle: SessionHandle = {
      id: created.session_id,
      branchId: branch.id,
      title: spec.title,
    };
    this.world.data.sessions[name] = handle;
    return handle;
  }

  /**
   * Run a real agent turn in a session and wait for it to finish. Needs the
   * cassette proxy (the seed must declare `agent: true`); the turn is
   * recorded live once and replayed after that.
   */
  async prompt(session: string, text: string, options: { as?: CastKey } = {}): Promise<void> {
    if (!resolveAgentMode()) {
      throw new Error('prompt() runs a real agent turn: declare agent: true on the seed');
    }
    const api = await this.as(options.as ?? 'sam');
    const s = this.world.session(session);
    await api.post(`/sessions/${s.id}/prompt`, {
      prompt: text,
      permissionMode: 'bypassPermissions',
    });
    await poll(
      `the agent turn in ${session}`,
      async () => {
        const tasks = await api.find<{ status: string; created_at: string }>('/tasks', {
          session_id: s.id,
          '$sort[created_at]': -1,
          $limit: 1,
        });
        const status = tasks[0]?.status;
        if (status === 'failed' || status === 'stopped' || status === 'timed_out') {
          throw new Error(`agent turn in ${session} ended ${status}`);
        }
        return status === 'completed' ? true : null;
      },
      15 * 60_000,
      2000
    );
  }

  /** A markdown note on a board. */
  async note(
    board: string,
    key: string,
    spec: { x: number; y: number; width?: number; content: string; as?: CastKey }
  ): Promise<void> {
    const api = await this.as(spec.as ?? 'sam');
    await api.patch(`/boards/${this.world.board(board).id}`, {
      _action: 'upsertObject',
      objectId: `markdown-${key}`,
      objectData: {
        type: 'markdown',
        x: spec.x,
        y: spec.y,
        width: spec.width ?? 360,
        content: spec.content,
      },
    });
  }

  /**
   * A comment thread on a board, pinned at a canvas point or to a zone,
   * with optional replies and reactions from other cast members.
   */
  async comment(
    board: string,
    spec: {
      as: CastKey;
      text: string;
      at: { x: number; y: number } | { zone: string; dx?: number; dy?: number };
      replies?: { as: CastKey; text: string }[];
      reactions?: { as: CastKey; emoji: string }[];
    }
  ): Promise<string> {
    const b = this.world.board(board);
    const api = await this.as(spec.as);
    const position =
      'zone' in spec.at
        ? {
            relative: {
              parent_id: spec.at.zone,
              parent_type: 'zone',
              offset_x: spec.at.dx ?? 24,
              offset_y: spec.at.dy ?? 24,
            },
          }
        : { absolute: spec.at };
    const thread = await api.post<{ comment_id: string }>('/board-comments', {
      board_id: b.id,
      content: spec.text,
      position,
    });
    for (const reply of spec.replies ?? []) {
      await (await this.as(reply.as)).post(`/board-comments/${thread.comment_id}/reply`, {
        content: reply.text,
      });
    }
    for (const reaction of spec.reactions ?? []) {
      await (await this.as(reaction.as)).post(
        `/board-comments/${thread.comment_id}/toggle-reaction`,
        { emoji: reaction.emoji }
      );
    }
    return thread.comment_id;
  }
}
