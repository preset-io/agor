import type { MarkdownBoardObject } from '../types/board';
import { renderTemplate } from './handlebars-helpers';

export const TEAMMATE_WELCOME_NOTE_OBJECT_ID = 'welcome-note';

export interface TeammateWelcomeNoteInput {
  teammateName: string;
  teammateEmoji?: string | null;
}

export const TEAMMATE_WELCOME_NOTE_TEMPLATE = `# Welcome to {{teammate.name}}'s Board {{teammate.emoji}}

This board is a shared workspace for you and **{{teammate.name}}**, your AI teammate, to shape and run workflows.

Use it to organize:

- 🌿 **Branches** — coding efforts and their agent sessions
- 🧩 **Cards** — entities your workflow cares about, like tickets, customers, patients, leads, or incidents
- 📝 **Notes** — shared context, instructions, diagrams, and checklists
- 🗺️ **Zones** — named areas that group work and can trigger prompts as branches move through them

| 👈 Teammate | Board | Chat 👉 |
| --- | --- | --- |
| Plan and set up workflows | Arrange branches, cards, notes, and zones | Work through conversations |

> Start by asking **{{teammate.name}}** to help set up this board for a workflow that's relevant to you.`;

export function buildTeammateWelcomeNoteContext({
  teammateName,
  teammateEmoji,
}: TeammateWelcomeNoteInput): Record<string, unknown> {
  const name = teammateName.trim().replace(/\s+/g, ' ') || 'your teammate';
  const emoji = teammateEmoji?.trim().replace(/\s+/g, ' ') || '🤖';

  return {
    teammate: {
      name,
      emoji,
    },
  };
}

/**
 * Render the static teammate board welcome note on the server.
 */
export function buildTeammateWelcomeNoteContent(input: TeammateWelcomeNoteInput): string {
  return renderTemplate(TEAMMATE_WELCOME_NOTE_TEMPLATE, buildTeammateWelcomeNoteContext(input), {
    onError: 'empty',
  });
}

export function buildTeammateWelcomeNoteObject(
  input: TeammateWelcomeNoteInput
): MarkdownBoardObject {
  return {
    type: 'markdown',
    x: 80,
    y: 80,
    width: 700,
    content: buildTeammateWelcomeNoteContent(input),
  };
}
