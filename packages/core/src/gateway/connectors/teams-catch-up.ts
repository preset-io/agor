/** Deterministic bounds for optional standard-channel RSC catch-up. */

export interface TeamsCatchUpActivity {
  activityId: string;
  timestamp: string;
  actorLabel: string;
  text: string;
  isBot: boolean;
  isMention: boolean;
}

export interface TeamsCatchUpResult {
  activities: TeamsCatchUpActivity[];
  complete: boolean;
  reason?: 'disabled' | 'unavailable' | 'truncated' | 'invalid';
  conversationId?: string;
  rootMessageId?: string | null;
  afterActivityId?: string | null;
  throughActivityId?: string;
  triggerActivityId?: string;
}

export interface TeamsCatchUpBounds {
  maxMessages: number;
  maxPromptBytes: number;
}

/** Keep history ephemeral, ordered, and bounded before it can become a prompt. */
export function boundTeamsCatchUp(
  activities: readonly TeamsCatchUpActivity[],
  bounds: TeamsCatchUpBounds
): TeamsCatchUpResult {
  if (
    !Number.isSafeInteger(bounds.maxMessages) ||
    bounds.maxMessages < 1 ||
    bounds.maxMessages > 100
  ) {
    return { activities: [], complete: false, reason: 'invalid' };
  }
  if (
    !Number.isSafeInteger(bounds.maxPromptBytes) ||
    bounds.maxPromptBytes < 1 ||
    bounds.maxPromptBytes > 64 * 1024
  ) {
    return { activities: [], complete: false, reason: 'invalid' };
  }
  const selected: TeamsCatchUpActivity[] = [];
  let bytes = 0;
  for (const activity of activities) {
    if (!activity.activityId || !activity.timestamp || !activity.text) {
      return { activities: selected, complete: false, reason: 'invalid' };
    }
    if (selected.length >= bounds.maxMessages)
      return { activities: selected, complete: false, reason: 'truncated' };
    const nextBytes = bytes + Buffer.byteLength(activity.text, 'utf8');
    if (nextBytes > bounds.maxPromptBytes)
      return { activities: selected, complete: false, reason: 'truncated' };
    selected.push({ ...activity });
    bytes = nextBytes;
  }
  return { activities: selected, complete: true };
}
