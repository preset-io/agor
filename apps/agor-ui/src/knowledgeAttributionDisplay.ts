import { shortId } from '@agor/core/types';

type UserSummary = { name?: string | null; email?: string | null };

export interface KnowledgeAttribution {
  userId?: string | null;
  sessionId?: string | null;
  agenticTool?: string | null;
}

export function knowledgeAttributionDisplay(
  attribution: KnowledgeAttribution,
  userById: ReadonlyMap<string, UserSummary>
) {
  const user = attribution.userId ? userById.get(attribution.userId) : undefined;
  const userLabel = user?.name?.trim() || user?.email || 'Unknown user';
  if (!attribution.sessionId) return { userLabel, assistantLabel: null };

  const toolLabel =
    attribution.agenticTool === 'claude-code'
      ? 'Claude Code'
      : attribution.agenticTool
        ? attribution.agenticTool.charAt(0).toUpperCase() + attribution.agenticTool.slice(1)
        : 'Assistant';
  return {
    userLabel,
    assistantLabel: `${toolLabel} · session ${shortId(attribution.sessionId as never)}`,
  };
}
