import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_WELCOME_NOTE_TEMPLATE,
  buildAssistantWelcomeNoteContent,
} from './assistantWelcomeNote';

describe('buildAssistantWelcomeNoteContent', () => {
  it('substitutes assistant name and emoji into the template', () => {
    const content = buildAssistantWelcomeNoteContent({
      assistantName: 'Product/Design Agor Board',
      assistantEmoji: '🧋',
    });

    expect(ASSISTANT_WELCOME_NOTE_TEMPLATE).toContain('{{assistant.name}}');
    expect(content).not.toContain('{{assistant.name}}');
    expect(content).not.toContain('{{assistant.emoji}}');
    expect(content).toContain("Product/Design Agor Board's Board 🧋");
    expect(content).toContain('**Product/Design Agor Board**');
  });

  it('falls back to defaults when name is empty and emoji is missing', () => {
    const content = buildAssistantWelcomeNoteContent({
      assistantName: '   ',
      assistantEmoji: null,
    });

    expect(content).toContain("your assistant's Board 🤖");
    expect(content).not.toContain('{{assistant.name}}');
    expect(content).not.toContain('{{assistant.emoji}}');
  });

  it('replaces all occurrences of the name placeholder', () => {
    const content = buildAssistantWelcomeNoteContent({
      assistantName: 'Bug Fixer',
      assistantEmoji: '🐛',
    });

    const occurrences = (content.match(/Bug Fixer/g) ?? []).length;
    const templateOccurrences = (
      ASSISTANT_WELCOME_NOTE_TEMPLATE.match(/\{\{assistant\.name\}\}/g) ?? []
    ).length;
    expect(occurrences).toBe(templateOccurrences);
  });
});
