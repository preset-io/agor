import type { Branch, Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { sortBoardTreeBranches } from './boardTree';

const branch = (id: string, teammate = false) =>
  ({
    branch_id: id,
    name: id,
    last_used: '2026-01-01T00:00:00Z',
    custom_context: teammate ? { teammate: { kind: 'teammate', displayName: id } } : {},
  }) as Branch;
const session = (id: string, time: string) =>
  ({ session_id: id, last_updated: time, archived: false }) as Session;
describe('board tree ordering', () => {
  it('pins primary, then teammates, then stable alphabetical branches, including empty branches', () => {
    const branches = [
      branch('Z'),
      branch('B'),
      branch('Primary', true),
      branch('Other', true),
      branch('A'),
    ];
    const sessions = new Map([['Z', [session('recent', '2026-10-23T00:00:00Z')]]]);
    expect(
      sortBoardTreeBranches(branches, 'Primary', 'alpha', sessions).map((b) => b.name)
    ).toEqual(['Primary', 'Other', 'A', 'B', 'Z']);
    expect(branches[0].name).toBe('Z'); // never reorder shared input
  });
  it('uses recent session activity only for ordinary branches when explicitly requested', () => {
    const branches = [branch('A'), branch('Z'), branch('Primary', true)];
    const sessions = new Map([['Z', [session('recent', '2026-10-23T00:00:00Z')]]]);
    expect(
      sortBoardTreeBranches(branches, 'Primary', 'recent', sessions).map((b) => b.name)
    ).toEqual(['Primary', 'Z', 'A']);
  });
  it('does not let archived sessions or branches affect active navigation', () => {
    const branches = [branch('A'), { ...branch('B'), archived: true }, branch('Z')];
    const sessions = new Map([
      ['Z', [{ ...session('old', '2026-10-23T00:00:00Z'), archived: true }]],
    ]);
    expect(
      sortBoardTreeBranches(branches, undefined, 'recent', sessions).map((b) => b.name)
    ).toEqual(['A', 'Z']);
  });
});
