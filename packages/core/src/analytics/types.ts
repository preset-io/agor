import type { AnalyticsPlugin } from 'analytics';

export type AnalyticsProperties = Record<string, unknown>;
export type AnalyticsContext = Record<string, unknown>;

/** Deployment-owned fields. Trusted tenant identity is handled separately by the logger. */
export const OPERATOR_OWNED_ANALYTICS_CONTEXT_KEYS: readonly string[] = Object.freeze([
  'app',
  'extras',
]);

export interface AnalyticsTrackOptions {
  userId?: string | null;
  anonymousId?: string | null;
  context?: AnalyticsContext;
}

export interface AnalyticsLogger {
  isEnabled(): boolean;
  track(event: string, properties?: AnalyticsProperties, options?: AnalyticsTrackOptions): void;
}

export type ResolvedAnalyticsPlugin = AnalyticsPlugin & {
  flush?: () => Promise<void> | void;
};
