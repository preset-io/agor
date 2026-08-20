import type { AgenticToolName, AgorClient, User } from '@agor-live/client';
import { getUserPrimaryAgenticTool } from '@agor-live/client';

/**
 * Seed a primary coding agent from a deliberate successful workflow without
 * ever replacing the preference owned by Settings. The daemon performs the
 * authoritative atomic check; the client check only avoids unnecessary RPCs.
 */
export async function setPrimaryAgenticToolIfUnset(
  client: AgorClient | null,
  user: User | null | undefined,
  tool: AgenticToolName
): Promise<User | null> {
  if (!client || !user || getUserPrimaryAgenticTool(user)) return user ?? null;
  return client.service('users').setPrimaryAgenticToolIfUnset({ tool });
}
