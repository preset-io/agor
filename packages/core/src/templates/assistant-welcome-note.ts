import type { MarkdownBoardObject } from '../types/board';
import { renderTemplate } from './handlebars-helpers';

export const ASSISTANT_WELCOME_NOTE_OBJECT_ID = 'welcome-note';

export interface AssistantWelcomeNoteInput {
  assistantName: string;
  assistantEmoji?: string | null;
}

export const ASSISTANT_WELCOME_NOTE_TEMPLATE = `# Welcome to {{assistant.name}}'s Board {{assistant.emoji}}

This board is a shared workspace for you and **{{assistant.name}}** to shape and run workflows.

Use it to organize:

- 🌿 **Branches** — coding efforts and their agent sessions
- 🧩 **Cards** — entities your workflow cares about, like tickets, customers, patients, leads, or incidents
- 📝 **Notes** — shared context, instructions, diagrams, and checklists
- 🗺️ **Zones** — named areas that group work and can trigger prompts as branches move through them

| 👈 Assistant | Board | Chat 👉 |
| --- | --- | --- |
| Plan and set up workflows | Arrange branches, cards, notes, and zones | Work through conversations |

> Start by asking **{{assistant.name}}** to help set up this board for a workflow that's relevant to you.`;

const LEGACY_WELCOME_NOTE_MARKERS = [
  '{{assistant.name}}',
  '{{assistant.emoji}}',
  '```mermaid',
  'flowchart LR',
  'Workflow building blocks',
  '<--- on your left',
];

const ASSISTANT_VALUE_PATTERN = /{{assistant\.(name|emoji)}}/g;
const ASSISTANT_VALUE_SPLIT_PATTERN = /{{assistant\.(?:name|emoji)}}/g;
const CURRENT_WELCOME_NOTE_STATIC_SEGMENTS = ASSISTANT_WELCOME_NOTE_TEMPLATE.split(
  ASSISTANT_VALUE_SPLIT_PATTERN
);
const CURRENT_WELCOME_NOTE_PLACEHOLDERS = Array.from(
  ASSISTANT_WELCOME_NOTE_TEMPLATE.matchAll(ASSISTANT_VALUE_PATTERN),
  (match) => match[1] as 'name' | 'emoji'
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCurrentWelcomeNoteTemplatePattern(): RegExp {
  const seenPlaceholders = new Set<'name' | 'emoji'>();
  let pattern = `^${escapeRegExp(CURRENT_WELCOME_NOTE_STATIC_SEGMENTS[0])}`;

  for (let index = 1; index < CURRENT_WELCOME_NOTE_STATIC_SEGMENTS.length; index += 1) {
    const placeholder = CURRENT_WELCOME_NOTE_PLACEHOLDERS[index - 1];

    if (seenPlaceholders.has(placeholder)) {
      pattern += `\\k<${placeholder}>`;
    } else {
      seenPlaceholders.add(placeholder);
      pattern += `(?<${placeholder}>[\\s\\S]*?)`;
    }

    pattern += escapeRegExp(CURRENT_WELCOME_NOTE_STATIC_SEGMENTS[index]);
  }

  return new RegExp(`${pattern}$`);
}

const CURRENT_WELCOME_NOTE_TEMPLATE_PATTERN = buildCurrentWelcomeNoteTemplatePattern();

/**
 * Escape text for Markdown inline/text contexts before Handlebars performs its
 * normal HTML escaping. The template source is trusted/static, but assistant
 * identity fields are user-provided and are rendered as Markdown text.
 */
function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!])/g, '\\$1');
}

export function buildAssistantWelcomeNoteContext({
  assistantName,
  assistantEmoji,
}: AssistantWelcomeNoteInput): Record<string, unknown> {
  const name = assistantName.trim().replace(/\s+/g, ' ') || 'your assistant';
  const emoji = assistantEmoji?.trim().replace(/\s+/g, ' ') || '🤖';

  return {
    assistant: {
      name: escapeMarkdownText(name),
      emoji: escapeMarkdownText(emoji),
    },
  };
}

/**
 * Render the static assistant board welcome note on the server.
 *
 * Security invariants:
 * - The Handlebars template is bundled/static for this path; callers only
 *   provide data values, never template source.
 * - Values are interpolated with normal double-stash expressions, so
 *   HTML-significant characters are escaped by Handlebars.
 * - Markdown metacharacters in values are escaped before rendering so names
 *   like `[docs](javascript:...)` remain text rather than links.
 */
export function buildAssistantWelcomeNoteContent(input: AssistantWelcomeNoteInput): string {
  return renderTemplate(ASSISTANT_WELCOME_NOTE_TEMPLATE, buildAssistantWelcomeNoteContext(input), {
    onError: 'empty',
  });
}

export function buildAssistantWelcomeNoteObject(
  input: AssistantWelcomeNoteInput
): MarkdownBoardObject {
  return {
    type: 'markdown',
    x: 80,
    y: 80,
    width: 700,
    content: buildAssistantWelcomeNoteContent(input),
  };
}

function matchesCurrentWelcomeNoteTemplateShape(content: string): boolean {
  return CURRENT_WELCOME_NOTE_TEMPLATE_PATTERN.test(content);
}

export function shouldReplaceAssistantWelcomeNoteContent(content: string): boolean {
  return (
    LEGACY_WELCOME_NOTE_MARKERS.some((marker) => content.includes(marker)) ||
    matchesCurrentWelcomeNoteTemplateShape(content)
  );
}
