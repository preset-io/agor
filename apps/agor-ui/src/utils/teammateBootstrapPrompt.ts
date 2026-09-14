import {
  buildGoalBootstrapGuidance,
  findOnboardingGoal,
  type OnboardingIntegrationRecommendation,
} from './onboardingGoals';
import type { OnboardingSlackGatewayIntent } from './onboardingSlack';
import { BLANK_TEMPLATE_ID, getTeammateTemplate } from './teammateTemplates';

export interface TeammateBootstrapPromptInput {
  slackGatewayIntent?: OnboardingSlackGatewayIntent;
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
}

export interface TeammateBootstrapPromptContext {
  slackGatewayIntent?: OnboardingSlackGatewayIntent;
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

  const userName = context.user?.name;
  if (context.hasPrimaryGoal) {
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
  } else if (context.templateTitle) {
    const helpTarget = userName ?? 'them';
    lines.push(
      `- Open as yourself: one warm line, in your persona's voice, naming who you are and that you're set up as a ${context.templateTitle} to help ${helpTarget}. Ground the opening in the template's remit; do not claim the user chose a goal.`
    );
    lines.push(
      "- Then 2-3 short bullets on how you'll help within that remit: concrete capabilities, not a catalog."
    );
    lines.push(
      '- Then act: take one concrete first-win step grounded in the template if live context supports it. If one essential fact blocks a useful step, ask one specific question tied to the template remit, never a generic one.'
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
      'When one of these would unlock the first win, name it, explain what it unlocks, and use only its setup route below. Do not wait to be asked, do not invent an endpoint, and do not treat every connection as MCP:'
    );
    for (const integration of context.suggestedIntegrations) {
      switch (integration.setup.surface) {
        case 'marketplace':
          lines.push(
            `- ${integration.name}: use the reviewed Catalog entry ${integration.setup.catalogEntryName}. Ask the user to connect it there; do not bypass the catalog by registering a guessed endpoint through MCP tools.`
          );
          break;
        case 'slack':
          lines.push(
            '- Slack means gateway messaging here, not an MCP recommendation. Follow the explicit gateway intent below; if absent, do not create a gateway. Slack MCP tool access is separate and not selected: it is unavailable in the reviewed Catalog because registered-client requirements remain unresolved. Do not offer generic connector registration, invent Catalog availability, or reuse gateway tokens for MCP.'
          );
          break;
        case 'connected-repository':
          lines.push(
            `- ${integration.name}: use the repository already connected to Agor, or ask which repository to add. Do not describe this as an MCP or Catalog install.`
          );
          break;
      }
    }
  }

  if (context.slackGatewayIntent) {
    lines.push(
      '- Slack messaging: prefer an existing usable gateway. Recheck live inventory and permissions; a gateway is bound to its current branch, with no cross-branch session bypass. Do not retarget it, copy its credentials, or silently create a duplicate. If it serves another teammate, explain that and guide the user to that existing teammate instead.'
    );
    if (context.slackGatewayIntent === 'request-new') {
      lines.push(
        '- The user explicitly asked for help creating a new Slack gateway if none is usable. Recheck the current caller’s admin permission and existing gateways immediately before setup. If permission is denied or uncertain, stop and explain. Collect non-secret choices, use agor_gateway_slack_manifest_generate, create one disabled draft with agor_gateway_channels_create, then agor_widgets_request_gateway_token. Never ask for tokens in chat or put them in tool arguments. Enable/report connected only after the secure widget verifies setup. Reuse a matching draft on retry.'
      );
    } else {
      lines.push(
        '- No new Slack gateway was requested. Do not create one; explain when an administrator is needed.'
      );
    }
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
  slackGatewayIntent,
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
    ...(slackGatewayIntent ? { slackGatewayIntent } : {}),
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
