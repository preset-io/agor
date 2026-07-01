/**
 * Onboarding-agent module barrel.
 *
 * See `./trigger.ts` and `./kickoff-prompt.ts` for the design rationale -
 * there is no dedicated onboarding session/agent type, just a
 * system-authored prompt queued through the existing prompt path.
 */

export type { OnboardingKickoffPromptInput, OnboardingTriggerReason } from './kickoff-prompt.js';
export { buildOnboardingKickoffPrompt } from './kickoff-prompt.js';
export type {
  OnboardingTriggerApp,
  TriggerOnboardingInput,
  TriggerOnboardingResult,
} from './trigger.js';
export {
  ONBOARDING_KNOWLEDGE_DOC_PATH,
  onboardingNamespaceSlug,
  triggerOnboarding,
} from './trigger.js';
