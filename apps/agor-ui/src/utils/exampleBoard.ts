import { isExampleBoardOwner, isExampleBoardRepo, type Repo } from '@agor-live/client';
import type { AgorState } from '../store/agorStore';

/** The seeded "Agor examples" user; everything it created is example data. */
export const selectExampleOwnerId = (s: Pick<AgorState, 'userById'>): string | undefined => {
  for (const user of s.userById.values()) if (isExampleBoardOwner(user)) return user.user_id;
  return undefined;
};

export const isExampleOwned = (
  entity: { created_by?: string } | null | undefined,
  exampleOwnerId: string | undefined
) => !!exampleOwnerId && entity?.created_by === exampleOwnerId;

let reposSource: AgorState['repoById'] | undefined;
let ownRepos = new Map<string, Repo>();
/** Repos a person can create branches in: everything except the example repo. */
export const selectCreatableRepoById = (s: Pick<AgorState, 'repoById'>) => {
  if (s.repoById !== reposSource) {
    reposSource = s.repoById;
    ownRepos = new Map([...s.repoById].filter(([, repo]) => !isExampleBoardRepo(repo)));
  }
  return ownRepos;
};
