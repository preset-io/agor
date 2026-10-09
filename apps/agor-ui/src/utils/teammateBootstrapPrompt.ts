import { BLANK_TEMPLATE_ID, getTeammateTemplate } from './teammateTemplates';

export interface TeammateBootstrapPromptInput {
  localHome?: boolean;
  displayName: string;
  emoji?: string | null;
  description?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  /**
   * Gallery template id (persona) the teammate was created from, if any. A real
   * (non-blank) template's title is surfaced as context and switches the opener
   * to the personal, persona-led path.
   */
  templateId?: string | null;
}

export interface TeammateBootstrapPromptContext {
  localHome?: boolean;
  teammate: {
    displayName: string;
    emoji: string;
    description?: string;
  };
  user?: {
    name?: string;
    email?: string;
  };
  /** Chosen template's title; present only when a real (non-blank) template resolved. */
  templateTitle?: string;
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

  lines.push('');
  lines.push(
    'Read ONBOARDING.md if it exists; otherwise, read BOOTSTRAP.md. Then respond to the user using the supplied context and live Agor state.'
  );
  lines.push('');
  lines.push(
    'Useful work comes first; do not start a repository, token, or backup setup interview. Keep memory, decisions, and docs in Agor Knowledge. Never publicly push, fork, or PR personal teammate state.'
  );
  if (context.localHome) {
    lines.push(
      'This is an independent local home without origin, not privately backed up. Commit locally; private backup is optional later, only with explicit user authorization for an additional private remote. Do not change the registered framework repository.'
    );
  }
  lines.push('Open the first session well:');
  lines.push(
    'Your first message sets the working relationship. Make it personal and easy to scan: a short intro, then the value, then one real step. No wall of text, and no generic "what do you want to do?" interview.'
  );

  const userName = context.user?.name;
  if (context.templateTitle) {
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
  templateId,
  localHome,
}: TeammateBootstrapPromptInput): TeammateBootstrapPromptContext {
  const normalizedUserName = userName?.trim();
  const normalizedUserEmail = userEmail?.trim();
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
    ...(templateTitle ? { templateTitle } : {}),
    ...(localHome ? { localHome: true } : {}),
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
