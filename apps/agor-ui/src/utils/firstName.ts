import type { User } from '@agor-live/client';

/** The first word of a person's name for greetings, or "there". */
export const firstNameOf = (user: Pick<User, 'name'> | null | undefined) =>
  user?.name?.trim().split(/\s+/)[0] || 'there';
