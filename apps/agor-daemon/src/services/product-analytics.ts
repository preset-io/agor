import { analyticsLogger } from '@agor/core/analytics';
import { requireCurrentTenantId } from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  EXAMPLE_BOARD_ANALYTICS_DESTINATIONS,
  EXAMPLE_BOARD_ANALYTICS_HIDE_ACTIONS,
  EXAMPLE_BOARD_ANALYTICS_OBJECTS,
  EXAMPLE_BOARD_ANALYTICS_SOURCES,
  ONBOARDING_ANALYTICS_ACTIONS,
  ONBOARDING_ANALYTICS_STEPS,
  PRODUCT_ANALYTICS_EVENTS,
} from '@agor/core/types';
import { z } from 'zod';

// Strict objects reject identity, URLs, arbitrary properties, and free-form errors.
const inputSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal(PRODUCT_ANALYTICS_EVENTS.HOME_VIEWED) }).strict(),
  z
    .object({
      event: z.literal(PRODUCT_ANALYTICS_EVENTS.ONBOARDING_STEP),
      step: z.enum(ONBOARDING_ANALYTICS_STEPS),
      action: z.enum(ONBOARDING_ANALYTICS_ACTIONS),
    })
    .strict(),
  z.object({ event: z.literal(PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_OPENED) }).strict(),
  z
    .object({
      event: z.literal(PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_OBJECT_OPENED),
      object: z.enum(EXAMPLE_BOARD_ANALYTICS_OBJECTS),
    })
    .strict(),
  z
    .object({
      event: z.literal(PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_MAKE_YOUR_OWN),
      source: z.enum(EXAMPLE_BOARD_ANALYTICS_SOURCES),
      destination: z.enum(EXAMPLE_BOARD_ANALYTICS_DESTINATIONS),
    })
    .strict(),
  z
    .object({
      event: z.literal(PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_HIDDEN),
      action: z.enum(EXAMPLE_BOARD_ANALYTICS_HIDE_ACTIONS),
    })
    .strict(),
]);

/** Registered only through the tenant-scoped authenticated route registrar. */
export class ProductAnalyticsService {
  async create(data: unknown, params: AuthenticatedParams) {
    const userId = params.user?.user_id;
    if (!userId) throw new NotAuthenticated('Authentication required');
    requireCurrentTenantId();
    const parsed = inputSchema.safeParse(data);
    if (!parsed.success) throw new BadRequest('Invalid product analytics event');
    const input = parsed.data;
    if (input.event === PRODUCT_ANALYTICS_EVENTS.ONBOARDING_STEP) {
      const isCompletion =
        input.action === 'completion_started' ||
        input.action === 'completion_failed' ||
        input.action === 'completed';
      const isFinalStep = input.step === 'done';
      if ((isCompletion && !isFinalStep) || (input.action === 'skipped' && isFinalStep)) {
        throw new BadRequest('Invalid onboarding analytics transition');
      }
    }
    const { event, ...properties } = input;
    analyticsLogger.track(event, properties, { userId });
    return { success: true };
  }
}
