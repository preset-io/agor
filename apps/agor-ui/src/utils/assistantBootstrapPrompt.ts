import { renderTemplate } from '@agor/core/templates/handlebars-helpers';

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

export const ASSISTANT_BOOTSTRAP_PROMPT_TEMPLATE = `### First boot instructions for Agor Assistant

Context:
- Assistant: {{assistant.displayName}} {{assistant.emoji}}
{{#if assistant.description}}- Assistant description: {{assistant.description}}
{{/if}}{{#if user.name}}- User: {{user.name}}{{#if user.email}} <{{user.email}}>{{/if}}
{{else}}{{#if user.email}}- User email: {{user.email}}
{{/if}}{{/if}}
Read BOOTSTRAP.md, then say hello and ask only the next useful questions to shape this assistant.`;

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
 * Shared by onboarding and the board plus-button creation flow. The prompt is
 * intentionally a Handlebars template so both flows pass the same assistant
 * identity params through one rendering path.
 */
export function buildAssistantBootstrapPrompt(input: AssistantBootstrapPromptInput): string {
  return renderTemplate(
    ASSISTANT_BOOTSTRAP_PROMPT_TEMPLATE,
    buildAssistantBootstrapPromptContext(input) as unknown as Record<string, unknown>,
    { onError: 'raw' }
  );
}
