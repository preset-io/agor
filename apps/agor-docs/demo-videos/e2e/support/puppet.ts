// Staging a board live, during a take: the moves agents would make (open a
// PR, move a card to the next zone, start a review session in another
// harness) made through the daemon's REST API, so they arrive on the
// filmed board over the realtime channel exactly as real ones do.
//
// For the parts of a story there are no keys for (Codex, Gemini, Copilot)
// or that take too long to film (a review loop). The UI, the cards, the
// session rows and their spinners are all real; what's staged is which
// agent did what, and when.

import type { AgorApi } from './api.ts';
import type { World } from './world.ts';

export type Harness = 'claude-code' | 'codex' | 'gemini' | 'copilot';

/** Card slots in a zone: stacked from the top, like the seeder's. */
export const slot = (n: number) => ({ x: 30, y: 70 + n * 230 });

export class Puppet {
  constructor(
    readonly api: AgorApi,
    readonly world: World,
    readonly board: string
  ) {}

  private branchId(name: string): string {
    return this.world.branch(name).id;
  }

  /** Move a branch card to a zone slot (no zone trigger fires: that's a drag in the UI). */
  async place(branch: string, zone: string, n: number): Promise<void> {
    const board = this.world.board(this.board);
    const [object] = await this.api.find<{ object_id: string }>('/board-objects', {
      board_id: board.id,
      branch_id: this.branchId(branch),
    });
    if (!object) throw new Error(`puppet: ${branch} is not on ${this.board}`);
    await this.api.patch(`/board-objects/${object.object_id}`, {
      position: slot(n),
      zone_id: board.zones[zone] ?? `zone-${zone}`,
    });
  }

  /** A session row on a branch's card, optionally running and nested under a parent. */
  async session(
    branch: string,
    spec: { agent?: Harness; title: string; running?: boolean; parent?: string }
  ): Promise<string> {
    const created = await this.api.post<{ session_id: string }>('/sessions', {
      branch_id: this.branchId(branch),
      agentic_tool: spec.agent ?? 'claude-code',
      title: spec.title,
      status: spec.running ? 'running' : 'idle',
      ...(spec.parent ? { genealogy: { parent_session_id: spec.parent, children: [] } } : {}),
    });
    if (spec.running) await this.running(created.session_id, true);
    return created.session_id;
  }

  /** Spin a session's row (and its card), or settle it. */
  async running(session: string, on: boolean): Promise<void> {
    await this.api.patch(`/sessions/${session}`, {
      status: on ? 'running' : 'idle',
      ready_for_prompt: !on,
    });
  }

  async retitle(session: string, title: string): Promise<void> {
    await this.api.patch(`/sessions/${session}`, { title });
  }

  /** Show a pull request on the card. */
  async pr(branch: string, url: string): Promise<void> {
    await this.api.patch(`/branches/${this.branchId(branch)}`, { pull_request_url: url });
  }
}
