import { getRepoCloneErrorHint, type RepoCloneErrorCategory } from '@agor/core/types';

export function cloneErrorHint(error?: {
  category?: RepoCloneErrorCategory;
  message?: string;
}): string {
  return getRepoCloneErrorHint(error);
}
