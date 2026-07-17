import { findOnboardingPersona } from './onboardingPersonas';

export interface TeammateBootstrapPromptInput {
  displayName: string;
  emoji?: string | null;
  description?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  /** Onboarding persona id (see ONBOARDING_PERSONAS); shapes how the teammate introduces itself. */
  persona?: string | null;
  /** Persona-tailored MCP integration names surfaced in the onboarding wizard. */
  suggestedIntegrations?: string[] | null;
}

export interface TeammateBootstrapPromptContext {
  teammate: {
    displayName: string;
    emoji: string;
    description?: string;
  };
  user?: {
    name?: string;
    email?: string;
  };
  persona?: { id: string; title?: string };
  suggestedIntegrations?: string[];
  firstSession: true;
}

export function buildTeammateOnboardingSessionTitle({
  displayName,
  emoji,
}: Pick<TeammateBootstrapPromptInput, 'displayName' | 'emoji'>): string {
  return `${emoji ? `${emoji} ` : ''}${displayName} onboarding`;
}

function formatTeammateBootstrapPrompt(context: TeammateBootstrapPromptContext): string {
  const lines = [
    '### First-session onboarding instructions for Agor AI teammate',
    '',
    'Context:',
    `- AI teammate: ${context.teammate.displayName} ${context.teammate.emoji}`,
  ];

  if (context.teammate.description) {
    lines.push(`- AI teammate description: ${context.teammate.description}`);
  }

  if (context.user?.name) {
    lines.push(
      `- User: ${context.user.name}${context.user.email ? ` <${context.user.email}>` : ''}`
    );
  } else if (context.user?.email) {
    lines.push(`- User email: ${context.user.email}`);
  }

  if (context.persona) {
    const suffix = context.persona.title ? ` (${context.persona.title})` : '';
    lines.push(`- User persona: ${context.persona.id}${suffix}`);
  }

  if (context.suggestedIntegrations?.length) {
    lines.push(`- Suggested integrations: ${context.suggestedIntegrations.join(', ')}`);
  }

  lines.push('');
  lines.push(
    "Read ONBOARDING.md if it exists; otherwise, read BOOTSTRAP.md. Then respond to the user. Use the supplied context and live Agor state, and ask only the next useful question if the user's goal is not already clear."
  );

  return lines.join('\n');
}

export function buildTeammateBootstrapPromptContext({
  displayName,
  emoji,
  description,
  userName,
  userEmail,
  persona,
  suggestedIntegrations,
}: TeammateBootstrapPromptInput): TeammateBootstrapPromptContext {
  const normalizedUserName = userName?.trim();
  const normalizedUserEmail = userEmail?.trim();
  const personaId = persona?.trim();
  const personaProfile = findOnboardingPersona(personaId);
  const normalizedIntegrations = suggestedIntegrations
    ?.map((name) => name.trim())
    .filter((name) => name.length > 0);

  return {
    teammate: {
      displayName: displayName.trim() || 'My Teammate',
      emoji: emoji?.trim() || '🤖',
      ...(description?.trim() ? { description: description.trim() } : {}),
    },
    ...(normalizedUserName || normalizedUserEmail
      ? {
          user: {
            ...(normalizedUserName ? { name: normalizedUserName } : {}),
            ...(normalizedUserEmail ? { email: normalizedUserEmail } : {}),
          },
        }
      : {}),
    ...(personaId
      ? { persona: { id: personaId, ...(personaProfile ? { title: personaProfile.title } : {}) } }
      : {}),
    ...(normalizedIntegrations?.length ? { suggestedIntegrations: normalizedIntegrations } : {}),
    firstSession: true,
  };
}

/**
 * First prompt for a newly-created AI teammate branch.
 *
 * Shared by onboarding, the board plus-button creation flow, and Settings →
 * Teammates creation. Keep this deterministic in the browser instead of
 * using the shared Handlebars renderer: browser-side Handlebars compilation
 * relies on `new Function`, which can violate CSP. Rich user-authored
 * template rendering should go through the daemon `/templates` service.
 */
export function buildTeammateBootstrapPrompt(input: TeammateBootstrapPromptInput): string {
  return formatTeammateBootstrapPrompt(buildTeammateBootstrapPromptContext(input));
}
