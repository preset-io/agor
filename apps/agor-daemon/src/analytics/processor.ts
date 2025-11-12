export interface AnalyticsEvent {
  event: string;
  timestamp: string;
  userId: string;
  properties: Record<string, unknown>;
}

export interface AnalyticsEventProcessor {
  track(event: AnalyticsEvent): Promise<void>;
  flush(): Promise<void>;
}

/**
 * No-op processor (default when SEGMENT_WRITE_KEY not set)
 */
export class NoOpProcessor implements AnalyticsEventProcessor {
  async track(_event: AnalyticsEvent): Promise<void> {
    // Do nothing
  }

  async flush(): Promise<void> {
    // Do nothing
  }
}
