import { buildGoalBootstrapGuidance } from './onboardingGoals';

export interface TeammateBootstrapPromptInput {
  displayName: string;
  emoji?: string | null;
  description?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  /**
   * Onboarding goal ids (see ONBOARDING_GOALS), order-preserving with the
   * first-picked goal primary. Present (possibly empty) for onboarding-created
   * teammates; omit entirely for teammates created outside onboarding.
   */
  goals?: string[] | null;
  /** Goal-tailored MCP integration names surfaced in the onboarding wizard. */
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
  /** Goal-driven guidance lines; present when goals were supplied. */
  goalGuidance?: string[];
  suggestedIntegrations?: string[];
  firstSession: true;
}

export function buildTeammateFirstSessionTitle({
  displayName,
  emoji,
}: Pick<TeammateBootstrapPromptInput, 'displayName' | 'emoji'>): string {
  return `${emoji ? `${emoji} ` : ''}${displayName} — first session`;
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

  if (context.suggestedIntegrations?.length) {
    lines.push(`- Suggested integrations: ${context.suggestedIntegrations.join(', ')}`);
  }

  if (context.goalGuidance?.length) {
    lines.push('');
    lines.push('What the user wants:');
    for (const line of context.goalGuidance) {
      lines.push(`- ${line}`);
    }
  }

  lines.push('');
  lines.push(
    'Read ONBOARDING.md if it exists; otherwise, read BOOTSTRAP.md. Then respond to the user using the supplied context and live Agor state.'
  );
  lines.push('');
  lines.push(
    'Open with a concrete first win rather than interviewing the user — take the primary goal above and act on it.'
  );
  if (context.suggestedIntegrations?.length) {
    // CP-11: the recommended integrations must be actively proposed, not just
    // listed as context, or the teammate silently ignores them.
    lines.push(
      'When one of the suggested integrations above would unlock that win, proactively propose connecting it — name the integration, say what it unlocks, and point the user to Settings → MCP. Do not wait to be asked.'
    );
  }

  return lines.join('\n');
}

export function buildTeammateBootstrapPromptContext({
  displayName,
  emoji,
  description,
  userName,
  userEmail,
  goals,
  suggestedIntegrations,
}: TeammateBootstrapPromptInput): TeammateBootstrapPromptContext {
  const normalizedUserName = userName?.trim();
  const normalizedUserEmail = userEmail?.trim();
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
    // A supplied (even empty) goals array marks an onboarding teammate and gets
    // goal-driven guidance; omitting goals entirely leaves the block off.
    ...(goals ? { goalGuidance: buildGoalBootstrapGuidance(goals) } : {}),
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
