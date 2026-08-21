import {
  buildGoalBootstrapGuidance,
  findOnboardingGoal,
  type OnboardingIntegrationRecommendation,
} from './onboardingGoals';
import { BLANK_TEMPLATE_ID, getTeammateTemplate } from './teammateTemplates';

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
  /**
   * Gallery template id (persona) the teammate was created from, if any. A real
   * (non-blank) template's title is surfaced as context and switches the opener
   * to the personal, persona-led path even when no goal was picked.
   */
  templateId?: string | null;
  /** Goal-tailored tools/connections with their real Agor setup surface. */
  suggestedIntegrations?: OnboardingIntegrationRecommendation[] | null;
  /**
   * Whether the acting user can connect MCP servers themselves (admin+). Drives
   * whether the opener offers to set a connection up, or defers to an admin.
   */
  canManageIntegrations?: boolean | null;
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
  hasPrimaryGoal?: boolean;
  /** Chosen template's title; present only when a real (non-blank) template resolved. */
  templateTitle?: string;
  suggestedIntegrations?: OnboardingIntegrationRecommendation[];
  /** True when the acting user can connect MCP servers themselves. */
  canManageIntegrations?: boolean;
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

  if (context.templateTitle) {
    lines.push(`- Created from the ${context.templateTitle} template.`);
  }

  if (context.user?.name) {
    lines.push(
      `- User: ${context.user.name}${context.user.email ? ` <${context.user.email}>` : ''}`
    );
  } else if (context.user?.email) {
    lines.push(`- User email: ${context.user.email}`);
  }

  if (context.suggestedIntegrations?.length) {
    lines.push(
      `- Suggested tools and connections: ${context.suggestedIntegrations.map((item) => item.name).join(', ')}`
    );
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
  lines.push('Open the first session well:');
  lines.push(
    'Your first message sets the working relationship. Make it personal and easy to scan: a short intro, then the value, then one real step. No wall of text, and no generic "what do you want to do?" interview.'
  );

  // A picked goal OR a template persona is enough to open personally; only the
  // no-goal, no-template case falls back to the single-question opener.
  const personalOpen = context.hasPrimaryGoal || Boolean(context.templateTitle);
  const userName = context.user?.name;
  if (personalOpen) {
    const helpTarget = userName ?? 'them';
    lines.push(
      `- Open as yourself: one warm line, in your persona's voice, naming who you are and that you're set up to help ${helpTarget} with what they picked (see "What the user wants" above). If your template persona and the user's goal diverge, lead with the user's goal.`
    );
    lines.push(
      "- Then 2-3 short bullets on how you'll help, specific to that goal: concrete capabilities, not a catalog."
    );
    lines.push(
      '- Then act: take one concrete first-win step now and show the result. If one essential fact blocks you, make one specific offer or ask one specific question, never a generic one.'
    );
    lines.push('- End with a single clear next step.');
  } else {
    const workingTarget = userName ?? 'the user';
    lines.push(
      `- Open as yourself in one line, then ask exactly one specific question about what ${workingTarget} is working on right now, and act on the answer immediately. Do not interview.`
    );
  }

  if (context.suggestedIntegrations?.length) {
    lines.push(
      context.canManageIntegrations
        ? "When a connection would unlock the win, say in one plain line what it unlocks, then offer to set it up for them yourself: register and connect it through the MCP tools or a secure credential flow, never asking for a secret in chat. Tell them they can review or disable it anytime under Settings -> MCP. Don't just point at the settings screen, and don't wait to be asked."
        : "When a connection would unlock the win, name it and what it unlocks, but explain a workspace admin has to connect it. Don't send this user to the admin-only MCP settings screen."
    );
  }

  lines.push(
    'When a relevant doc exists (check Agor Knowledge, or a "Further reading" pointer in your ONBOARDING.md), link the single most relevant one instead of pasting a how-to.'
  );

  return lines.join('\n');
}

export function buildTeammateBootstrapPromptContext({
  displayName,
  emoji,
  description,
  userName,
  userEmail,
  goals,
  templateId,
  suggestedIntegrations,
  canManageIntegrations,
}: TeammateBootstrapPromptInput): TeammateBootstrapPromptContext {
  const normalizedUserName = userName?.trim();
  const normalizedUserEmail = userEmail?.trim();
  const normalizedIntegrations = suggestedIntegrations?.filter(
    (integration) => integration.name.trim().length > 0
  );
  // The blank starter is "no template" — never surface it as a persona.
  const templateTitle =
    templateId && templateId !== BLANK_TEMPLATE_ID
      ? getTeammateTemplate(templateId)?.title
      : undefined;

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
    // Only lead with the primary-goal opener when a goal actually resolves — an
    // empty (skip) or all-unknown goals array has no primary goal to act on.
    ...(goals?.some((id) => findOnboardingGoal(id)) ? { hasPrimaryGoal: true } : {}),
    ...(templateTitle ? { templateTitle } : {}),
    ...(normalizedIntegrations?.length ? { suggestedIntegrations: normalizedIntegrations } : {}),
    ...(canManageIntegrations ? { canManageIntegrations: true } : {}),
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
