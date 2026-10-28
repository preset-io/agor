/** Closed, content-free browser event contract. Not the community telemetry channel. */
export const PRODUCT_ANALYTICS_SERVICE = 'analytics/product-events';
export const PRODUCT_ANALYTICS_EVENTS = {
  LOGIN_SUCCEEDED: 'auth.login_succeeded',
  HOME_VIEWED: 'home.viewed',
  ONBOARDING_STEP: 'onboarding.step',
  EXAMPLE_BOARD_OPENED: 'example_board.opened',
  EXAMPLE_BOARD_OBJECT_OPENED: 'example_board.object_opened',
  EXAMPLE_BOARD_MAKE_YOUR_OWN: 'example_board.make_your_own',
  EXAMPLE_BOARD_HIDDEN: 'example_board.hidden',
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

export const EXAMPLE_BOARD_ANALYTICS_OBJECTS = ['session'] as const;
export const EXAMPLE_BOARD_ANALYTICS_SOURCES = ['banner', 'session'] as const;
export type ExampleBoardAnalyticsSource = (typeof EXAMPLE_BOARD_ANALYTICS_SOURCES)[number];
/** Where "Make your own" sent the person: the wizard, or their own teammate's board. */
export const EXAMPLE_BOARD_ANALYTICS_DESTINATIONS = ['onboarding', 'teammate_board'] as const;
export const EXAMPLE_BOARD_ANALYTICS_HIDE_ACTIONS = ['hidden', 'restored'] as const;

export type ProductAnalyticsInput =
  | { event: typeof PRODUCT_ANALYTICS_EVENTS.HOME_VIEWED }
  | {
      event: typeof PRODUCT_ANALYTICS_EVENTS.ONBOARDING_STEP;
      step: OnboardingAnalyticsStep;
      action: OnboardingAnalyticsAction;
    }
  | { event: typeof PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_OPENED }
  | {
      event: typeof PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_OBJECT_OPENED;
      object: (typeof EXAMPLE_BOARD_ANALYTICS_OBJECTS)[number];
    }
  | {
      event: typeof PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_MAKE_YOUR_OWN;
      source: ExampleBoardAnalyticsSource;
      destination: (typeof EXAMPLE_BOARD_ANALYTICS_DESTINATIONS)[number];
    }
  | {
      event: typeof PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_HIDDEN;
      action: (typeof EXAMPLE_BOARD_ANALYTICS_HIDE_ACTIONS)[number];
    };
