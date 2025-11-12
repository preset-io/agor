import type { Application } from '@agor/core/feathers';
import type { EventFilter } from '../analytics/filters';
import { shouldFilterEvent } from '../analytics/filters';
import type { AnalyticsEvent, AnalyticsEventProcessor } from '../analytics/processor';

export class AnalyticsService {
  private processor: AnalyticsEventProcessor;
  private filter: EventFilter;

  constructor(processor: AnalyticsEventProcessor, filter: EventFilter) {
    this.processor = processor;
    this.filter = filter;
  }

  /**
   * Track a custom event (for manual instrumentation)
   */
  async track(event: AnalyticsEvent): Promise<void> {
    if (shouldFilterEvent(event.event, this.filter)) {
      return; // Filtered out
    }

    await this.processor.track(event);
  }

  /**
   * Register app-level hooks for passive capture
   */
  registerHooks(app: Application): void {
    app.hooks({
      after: {
        all: [this.createTrackingHook()],
      },
    });
  }

  /**
   * Create FeathersJS hook for passive event tracking
   */
  private createTrackingHook() {
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook context type compatibility
    return async (context: any) => {
      try {
        const event = this.buildEventFromContext(context);

        // Track asynchronously (don't block response)
        this.track(event).catch(err => {
          console.error('Analytics tracking error:', err);
        });
      } catch (err) {
        // Never throw from analytics hook (fail silently)
        console.error('Analytics hook error:', err);
      }

      return context;
    };
  }

  /**
   * Build analytics event from FeathersJS context
   */
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS hook context type compatibility
  private buildEventFromContext(context: any): AnalyticsEvent {
    const { method, path, result, params } = context;

    return {
      event: `${path}.${method}`,
      timestamp: new Date().toISOString(),
      userId: params.user?.user_id || 'anonymous',
      properties: {
        service: path,
        method: method,

        // Extract entity IDs from result
        ...(result?.session_id && { sessionId: result.session_id }),
        ...(result?.task_id && { taskId: result.task_id }),
        ...(result?.worktree_id && { worktreeId: result.worktree_id }),
        ...(result?.board_id && { boardId: result.board_id }),
        ...(result?.repo_id && { repoId: result.repo_id }),
        ...(result?.user_id && { affectedUserId: result.user_id }),

        // Status/agent context
        ...(result?.status && { status: result.status }),
        ...(result?.agentic_tool && { agenticTool: result.agentic_tool }),

        // Usage data (from tasks!)
        ...(result?.data?.usage && { usage: result.data.usage }),
      },
    };
  }

  /**
   * Flush pending events (call on shutdown)
   */
  async flush(): Promise<void> {
    await this.processor.flush();
  }
}
