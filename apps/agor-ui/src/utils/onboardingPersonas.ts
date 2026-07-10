/**
 * Canonical onboarding persona profiles.
 *
 * Single source of truth for the onboarding wizard's persona cards and for the
 * AI-teammate bootstrap prompt, so the label/description a user picks in
 * onboarding is the same text the teammate is told about. The `id` is the
 * stable value persisted to `user.preferences.onboarding.persona`.
 */
export interface OnboardingPersona {
  id: string;
  emoji: string;
  title: string;
  desc: string;
}

export const ONBOARDING_PERSONAS: OnboardingPersona[] = [
  {
    id: 'developer',
    emoji: '🔨',
    title: 'I write code',
    desc: 'AI does the repetitive parts - I focus on what is actually hard.',
  },
  {
    id: 'pm',
    emoji: '📋',
    title: 'I manage projects',
    desc: "AI drafts, summarizes, and chases status so I don't have to.",
  },
  {
    id: 'lead',
    emoji: '🎯',
    title: 'I lead a team',
    desc: 'AI multiplies what my team can do. I set direction, it handles the rest.',
  },
  {
    id: 'solo',
    emoji: '⚡',
    title: 'Building solo',
    desc: 'AI is the rest of the team - research, writing, execution, all of it.',
  },
];

export function findOnboardingPersona(id?: string | null): OnboardingPersona | undefined {
  return id ? ONBOARDING_PERSONAS.find((persona) => persona.id === id) : undefined;
}
