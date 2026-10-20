/** Closed, content-free browser event contract. Not the community telemetry channel. */
export const PRODUCT_ANALYTICS_SERVICE = 'analytics/product-events';
export const PRODUCT_ANALYTICS_EVENTS = {
  LOGIN_SUCCEEDED: 'auth.login_succeeded',
  HOME_VIEWED: 'home.viewed',
  ONBOARDING_STEP: 'onboarding.step',
} as const;

/** These are the wizard's actual navigation IDs, not its translated labels. */
export const ONBOARDING_ANALYTICS_STEPS = ['workspace', 'llm', 'tools', 'done'] as const;
export type OnboardingAnalyticsStep = (typeof ONBOARDING_ANALYTICS_STEPS)[number];
export const ONBOARDING_ANALYTICS_ACTIONS = [
  'started',
  'viewed',
  'skipped',
  'deferred',
  'completion_started',
  'completion_failed',
  'completed',
] as const;
export type OnboardingAnalyticsAction = (typeof ONBOARDING_ANALYTICS_ACTIONS)[number];

export type ProductAnalyticsInput =
  | { event: typeof PRODUCT_ANALYTICS_EVENTS.HOME_VIEWED }
  | {
      event: typeof PRODUCT_ANALYTICS_EVENTS.ONBOARDING_STEP;
      step: OnboardingAnalyticsStep;
      action: OnboardingAnalyticsAction;
    };
