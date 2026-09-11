/** Shared wire name for operator analytics and opt-in community telemetry. */
export const SEGMENT_TRACK_EVENT_NAME = 'agor_event';

/** Keep semantic names internal; reserve event_type only on the outbound copy. */
export function segmentTrackFields(
  eventType: string | undefined,
  properties: Record<string, unknown> = {}
): { event: string; properties: Record<string, unknown> } {
  return {
    event: SEGMENT_TRACK_EVENT_NAME,
    properties: { ...properties, event_type: eventType },
  };
}
