import { renderTemplate } from '@agor/core/templates/handlebars-helpers';
import type { AgorClient, Board, BoardID, BoardObject } from '@agor-live/client';

export const ASSISTANT_WELCOME_NOTE_OBJECT_ID = 'welcome-note';

export interface AssistantWelcomeNoteInput {
  client: AgorClient | null;
  boardId: BoardID | string;
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

export function buildAssistantWelcomeNoteContent({
  assistantName,
  assistantEmoji,
}: Pick<AssistantWelcomeNoteInput, 'assistantName' | 'assistantEmoji'>): string {
  const name = assistantName.trim() || 'your assistant';
  return renderTemplate(
    ASSISTANT_WELCOME_NOTE_TEMPLATE,
    {
      assistant: {
        name,
        emoji: assistantEmoji?.trim() || '🤖',
      },
    },
    { onError: 'raw' }
  );
}

/**
 * Adds the initial markdown note to a newly-created assistant board.
 * Best-effort: failure should not block assistant/board creation.
 */
export async function ensureAssistantWelcomeNote({
  client,
  boardId,
  assistantName,
  assistantEmoji,
}: AssistantWelcomeNoteInput): Promise<void> {
  if (!client || !boardId) return;

  const content = buildAssistantWelcomeNoteContent({ assistantName, assistantEmoji });
  const objectData: BoardObject = {
    type: 'markdown',
    x: 80,
    y: 80,
    width: 700,
    content,
  };

  try {
    const board = (await client.service('boards').get(boardId)) as Board;
    const existing = board.objects?.[ASSISTANT_WELCOME_NOTE_OBJECT_ID];
    if (existing) {
      if (
        existing.type === 'markdown' &&
        (existing.content.includes('```mermaid') ||
          existing.content.includes('flowchart LR') ||
          existing.content.includes('Workflow building blocks') ||
          existing.content.includes('<--- on your left'))
      ) {
        await client.service('boards').patch(boardId, {
          _action: 'upsertObject',
          objectId: ASSISTANT_WELCOME_NOTE_OBJECT_ID,
          objectData: {
            ...existing,
            content,
          },
        } as unknown as Partial<Board>);
      }
      return;
    }

    await client.service('boards').patch(boardId, {
      _action: 'upsertObject',
      objectId: ASSISTANT_WELCOME_NOTE_OBJECT_ID,
      objectData,
    } as unknown as Partial<Board>);
  } catch (error) {
    console.warn('Failed to create assistant welcome note:', error);
  }
}
