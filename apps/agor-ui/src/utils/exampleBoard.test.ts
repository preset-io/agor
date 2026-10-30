import {
  type Board,
  type Branch,
  EXAMPLE_BOARD_OWNER_EMAIL,
  EXAMPLE_BOARD_REPO_SLUG,
  type Repo,
  type User,
} from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { EMPTY_MAPS } from '../store/agorMaps';
import type { AgorState } from '../store/agorStore';
import { liveBoardIds, makeTeammatesSelector } from '../store/homeSelectors';
import { selectCreatableRepoById, selectExampleOwnerId } from './exampleBoard';

const EXAMPLES = 'user-examples';
const state = (): AgorState =>
  ({
    ...EMPTY_MAPS,
    userById: new Map([
      ['me', { user_id: 'me', email: 'me@example.test' } as User],
      [EXAMPLES, { user_id: EXAMPLES, email: EXAMPLE_BOARD_OWNER_EMAIL } as User],
    ]),
    boardById: new Map([
      ['example', { board_id: 'example', created_by: EXAMPLES, archived: false } as Board],
      ['shared', { board_id: 'shared', created_by: 'teammate', archived: false } as Board],
    ]),
    branchById: new Map([
      [
        'wendy',
        {
          branch_id: 'wendy',
          created_by: EXAMPLES,
          board_id: 'example',
          archived: false,
          custom_context: { teammate: { kind: 'teammate', displayName: 'Wendy' } },
        } as unknown as Branch,
      ],
      [
        'ada',
        {
          branch_id: 'ada',
          created_by: 'teammate',
          board_id: 'shared',
          archived: false,
          custom_context: { teammate: { kind: 'teammate', displayName: 'Ada' } },
        } as unknown as Branch,
      ],
    ]),
    repoById: new Map([
      ['example-repo', { repo_id: 'example-repo', slug: EXAMPLE_BOARD_REPO_SLUG } as Repo],
      ['own-repo', { repo_id: 'own-repo', slug: 'acme/web' } as Repo],
    ]),
  }) as unknown as AgorState;

describe('example board exclusions', () => {
  it('finds the example owner by its reserved email', () => {
    expect(selectExampleOwnerId(state())).toBe(EXAMPLES);
    expect(selectExampleOwnerId({ userById: new Map() })).toBeUndefined();
  });

  it('keeps the example teammate out of shared teammates', () => {
    const shared = makeTeammatesSelector('me', 'shared')(state());
    expect(shared.map((b) => b.branch_id)).toEqual(['ada']);
  });

  it('keeps the example board out of recent boards', () => {
    expect(liveBoardIds(state(), ['example', 'shared'])).toEqual(['shared']);
  });

  it('never offers the example repo for new branches', () => {
    expect([...selectCreatableRepoById(state()).keys()]).toEqual(['own-repo']);
  });
});
