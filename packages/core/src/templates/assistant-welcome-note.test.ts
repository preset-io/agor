import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_WELCOME_NOTE_TEMPLATE,
  buildAssistantWelcomeNoteContent,
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
    expect(content).toContain('&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;');
    expect(content).toContain('&lt;svg onload&#x3D;alert(1)&gt;');
  });
});
