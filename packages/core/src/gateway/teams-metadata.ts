/** Teams activity metadata that may be stored or forwarded; everything else is dropped. */
export const TEAMS_SAFE_METADATA_KEYS = [
  'teams_conversation_type',
  'teams_channel_type',
  'teams_channel_name',
  'teams_team_name',
  'teams_user_name',
  'teams_has_mention',
] as const;

/** Keep only allowlisted string/boolean Teams metadata. */
export function safeTeamsMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of TEAMS_SAFE_METADATA_KEYS) {
    const value = metadata?.[key];
    if (typeof value === 'string' || typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}
