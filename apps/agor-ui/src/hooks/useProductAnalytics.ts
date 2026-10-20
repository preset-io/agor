import { type OnboardingAnalyticsStep, PRODUCT_ANALYTICS_EVENTS } from '@agor-live/client';
import { useEffect, useRef } from 'react';
import { trackProductEvent } from '../utils/productAnalytics';

/** One view per mounted Home visit, not per render, query change, or socket reconnect. */
export function useHomeViewAnalytics(userId: string | undefined) {
  const viewedUser = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!userId || viewedUser.current === userId) return;
    viewedUser.current = userId;
    trackProductEvent(userId, { event: PRODUCT_ANALYTICS_EVENTS.HOME_VIEWED });
  }, [userId]);
}

/** One start per open activation and views only when its normalized step changes. */
export function useOnboardingViewAnalytics(
  userId: string | undefined,
  open: boolean,
  step: OnboardingAnalyticsStep
) {
  const previous = useRef<{ userId: string; step: OnboardingAnalyticsStep } | null>(null);
  useEffect(() => {
    if (!open || !userId) {
      previous.current = null;
      return;
    }
    // Opening can synchronously seed a saved step in another effect. Observe
    // the settled step, not the transient default; also cancels StrictMode replay.
    const timer = setTimeout(() => {
      if (previous.current?.userId !== userId) {
        trackProductEvent(userId, {
          event: PRODUCT_ANALYTICS_EVENTS.ONBOARDING_STEP,
          step,
          action: 'started',
        });
      }
      if (previous.current?.userId !== userId || previous.current.step !== step) {
        trackProductEvent(userId, {
          event: PRODUCT_ANALYTICS_EVENTS.ONBOARDING_STEP,
          step,
          action: 'viewed',
        });
      }
      previous.current = { userId, step };
    }, 0);
    return () => clearTimeout(timer);
  }, [userId, open, step]);
}
