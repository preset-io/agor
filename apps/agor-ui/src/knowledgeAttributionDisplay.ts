import type { KnowledgeUserAttribution, KnowledgeWriteAttribution } from '@agor/core/types';

type UserSummary = { name?: string | null };

export type KnowledgeAttribution = {
  userId?: string | null;
  user?: KnowledgeUserAttribution | null;
} & {
  [Key in keyof KnowledgeWriteAttribution]?: KnowledgeWriteAttribution[Key] | null;
};

export function knowledgeAttributionDisplay(
  attribution: KnowledgeAttribution,
  userById: ReadonlyMap<string, UserSummary>
) {
  const user = attribution.userId ? userById.get(attribution.userId) : undefined;
  // The Knowledge response is authoritative. The map lookup remains only for
  // rolling compatibility with an older daemon, and never falls back to email.
  const userLabel = attribution.user?.display_name.trim() || user?.name?.trim() || 'Unknown user';
  const teammateLabel = attribution.teammateName?.trim();
  if (!teammateLabel && !attribution.sessionId && !attribution.agenticTool) {
    return { userLabel, assistantLabel: null, editorLabel: userLabel };
  }

  const assistantLabel =
    teammateLabel ||
    (attribution.agenticTool === 'claude-code'
      ? 'Claude Code'
      : attribution.agenticTool
        ? attribution.agenticTool.charAt(0).toUpperCase() + attribution.agenticTool.slice(1)
        : 'Assistant');
  return {
    userLabel,
    assistantLabel,
    editorLabel: `${userLabel} and ${assistantLabel}`,
  };
}
