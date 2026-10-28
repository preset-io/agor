/**
 * Example board ownership marker. Everything the example board seeder writes is
 * created by this system user, so `created_by === exampleOwnerId` identifies
 * example data on every entity. The `.invalid` TLD can never be issued, so no
 * login or email-linking path can claim this account.
 */
export const EXAMPLE_BOARD_OWNER_EMAIL = 'examples@agor.invalid';
export const EXAMPLE_BOARD_OWNER_NAME = 'Agor examples';

export function isExampleBoardOwner(user: { email?: string } | null | undefined): boolean {
  return user?.email === EXAMPLE_BOARD_OWNER_EMAIL;
}

/** Repos carry no creator, so the example repo is marked by its reserved slug. */
export const EXAMPLE_BOARD_REPO_SLUG = 'example-northwind-web';

export function isExampleBoardRepo(repo: { slug?: string } | null | undefined): boolean {
  return repo?.slug === EXAMPLE_BOARD_REPO_SLUG;
}
