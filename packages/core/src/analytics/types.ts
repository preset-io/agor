import type { AnalyticsPlugin } from 'analytics';

export type AnalyticsProperties = Record<string, unknown>;
export type AnalyticsContext = Record<string, unknown>;

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
