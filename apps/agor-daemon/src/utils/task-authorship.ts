import type {
  PromptDraftProvenance,
  TaskAnalyticsOrigin,
  TaskAuthorship,
  TaskMetadata,
} from '@agor/core/types';

/** Admission-time analytics facts the prompt route knows but does not persist. */
export interface TaskCreatedAnalytics {
  origin?: TaskAnalyticsOrigin;
  draft?: PromptDraftProvenance;
}

/** Affirmative human provenance only; anything synthesized or unattributed is not `human`. */
export function classifyTaskAuthorship(
  metadata: TaskMetadata | undefined,
  origin?: TaskAnalyticsOrigin
): TaskAuthorship {
  if (metadata?.is_agor_callback) return 'callback';
  if (metadata?.system_authored) return 'system';
  if (metadata?.prompt_provenance) return 'agent';
  if (origin) return origin;
  if (metadata?.source === 'gateway') return 'gateway';
  if (metadata?.source === 'agor') return 'human';
  return 'internal';
}
