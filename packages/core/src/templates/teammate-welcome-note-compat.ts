import type { MarkdownBoardObject } from '../types/board';
import {
  buildTeammateWelcomeNoteContent,
  buildTeammateWelcomeNoteContext,
  buildTeammateWelcomeNoteObject,
  TEAMMATE_WELCOME_NOTE_OBJECT_ID,
  TEAMMATE_WELCOME_NOTE_TEMPLATE,
} from './teammate-welcome-note';

export const ASSISTANT_WELCOME_NOTE_OBJECT_ID = TEAMMATE_WELCOME_NOTE_OBJECT_ID;
export const ASSISTANT_WELCOME_NOTE_TEMPLATE = TEAMMATE_WELCOME_NOTE_TEMPLATE;

export interface AssistantWelcomeNoteInput {
  assistantName: string;
  assistantEmoji?: string | null;
}

function toTeammateInput(input: AssistantWelcomeNoteInput) {
  return {
    teammateName: input.assistantName,
    teammateEmoji: input.assistantEmoji,
  };
}

/** @deprecated Use buildTeammateWelcomeNoteContext instead. */
export function buildAssistantWelcomeNoteContext(input: AssistantWelcomeNoteInput) {
  return buildTeammateWelcomeNoteContext(toTeammateInput(input));
}

/** @deprecated Use buildTeammateWelcomeNoteContent instead. */
export function buildAssistantWelcomeNoteContent(input: AssistantWelcomeNoteInput): string {
  return buildTeammateWelcomeNoteContent(toTeammateInput(input));
}

/** @deprecated Use buildTeammateWelcomeNoteObject instead. */
export function buildAssistantWelcomeNoteObject(
  input: AssistantWelcomeNoteInput
): MarkdownBoardObject {
  return buildTeammateWelcomeNoteObject(toTeammateInput(input));
}
