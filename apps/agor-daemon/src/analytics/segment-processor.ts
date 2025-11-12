import { Analytics } from '@segment/analytics-node';
import type { AnalyticsEvent, AnalyticsEventProcessor } from './processor';

export class SegmentProcessor implements AnalyticsEventProcessor {
  private analytics: Analytics;

  constructor(writeKey: string) {
    this.analytics = new Analytics({
      writeKey,
      maxEventsInBatch: 15,
      flushInterval: 10000, // 10 seconds
    });
  }

  async track(event: AnalyticsEvent): Promise<void> {
    // Non-blocking, queued internally
    this.analytics.track({
      userId: event.userId,
      event: event.event,
      timestamp: new Date(event.timestamp),
      properties: event.properties,
    });
  }

  async flush(): Promise<void> {
    await this.analytics.flush();
  }
}
