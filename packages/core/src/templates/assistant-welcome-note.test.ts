import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_WELCOME_NOTE_TEMPLATE,
  buildAssistantWelcomeNoteContent,
  shouldReplaceAssistantWelcomeNoteContent,
} from './assistant-welcome-note';

describe('assistant-welcome-note', () => {
  it('renders the static Handlebars template with assistant identity params', () => {
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

  it('uses Handlebars double-stash escaping for HTML-looking assistant values', () => {
    const content = buildAssistantWelcomeNoteContent({
      assistantName: '<img src=x onerror=alert(1)>',
      assistantEmoji: '<svg onload=alert(1)>',
    });

    expect(content).not.toContain('<img src=x onerror=alert(1)>');
    expect(content).not.toContain('<svg onload=alert(1)>');
    expect(content).toContain('&lt;img src&#x3D;x onerror&#x3D;alert\\(1\\)&gt;');
    expect(content).toContain('&lt;svg onload&#x3D;alert\\(1\\)&gt;');
  });

  it('escapes Markdown metacharacters in assistant values so links remain text', () => {
    const content = buildAssistantWelcomeNoteContent({
      assistantName: '[docs](javascript:alert(1))',
      assistantEmoji: '[bot](javascript:alert(1))',
    });

    expect(content).not.toContain('[docs](javascript:alert(1))');
    expect(content).toContain('\\[docs\\]\\(javascript:alert\\(1\\)\\)');
    expect(content).toContain('\\[bot\\]\\(javascript:alert\\(1\\)\\)');
  });

  it('detects unresolved placeholder, legacy, and generated welcome-note content for backfill', () => {
    expect(shouldReplaceAssistantWelcomeNoteContent('# Welcome {{assistant.name}}')).toBe(true);
    expect(shouldReplaceAssistantWelcomeNoteContent('```mermaid\nflowchart LR')).toBe(true);
    expect(
      shouldReplaceAssistantWelcomeNoteContent(
        buildAssistantWelcomeNoteContent({
          assistantName: '[docs](javascript:alert(1))',
          assistantEmoji: '🤖',
        })
      )
    ).toBe(true);
    expect(shouldReplaceAssistantWelcomeNoteContent('My custom note')).toBe(false);
    expect(
      shouldReplaceAssistantWelcomeNoteContent(
        `${buildAssistantWelcomeNoteContent({
          assistantName: 'Edited Bot',
          assistantEmoji: '🤖',
        })}\n\nCustom user addition`
      )
    ).toBe(false);
    expect(
      shouldReplaceAssistantWelcomeNoteContent(
        buildAssistantWelcomeNoteContent({
          assistantName: 'Edited Bot',
          assistantEmoji: '🤖',
        }).replace("Edited Bot's Board", "Renamed Bot's Board")
      )
    ).toBe(false);
  });
});
