export interface AssistantBootstrapPromptInput {
  displayName: string;
  emoji?: string | null;
  description?: string | null;
  userName?: string | null;
  userEmail?: string | null;
}

export interface AssistantBootstrapPromptContext {
  assistant: {
    displayName: string;
    emoji: string;
    description?: string;
  };
  user?: {
    name?: string;
    email?: string;
  };
  firstSession: true;
}

function formatAssistantBootstrapPrompt(context: AssistantBootstrapPromptContext): string {
  const lines = [
    '### First boot instructions for Agor Assistant',
    '',
    'Context:',
    `- Assistant: ${context.assistant.displayName} ${context.assistant.emoji}`,
  ];

  if (context.assistant.description) {
    lines.push(`- Assistant description: ${context.assistant.description}`);
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
    'Read BOOTSTRAP.md, then say hello and ask only the next useful questions to shape this assistant.'
  );

  return lines.join('\n');
}

export function buildAssistantBootstrapPromptContext({
  displayName,
  emoji,
  description,
  userName,
  userEmail,
}: AssistantBootstrapPromptInput): AssistantBootstrapPromptContext {
  const normalizedUserName = userName?.trim();
  const normalizedUserEmail = userEmail?.trim();

  return {
    assistant: {
      displayName: displayName.trim() || 'My Assistant',
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
    firstSession: true,
  };
}

/**
 * First prompt for a newly-created Assistant branch.
 *
 * Shared by onboarding, the board plus-button creation flow, and Settings →
 * Assistants creation. Keep this deterministic in the browser instead of
 * using the shared Handlebars renderer: browser-side Handlebars compilation
 * relies on `new Function`, which can violate CSP. Rich user-authored
 * template rendering should go through the daemon `/templates` service.
 */
export function buildAssistantBootstrapPrompt(input: AssistantBootstrapPromptInput): string {
  return formatAssistantBootstrapPrompt(buildAssistantBootstrapPromptContext(input));
}
