import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_WELCOME_NOTE_TEMPLATE,
  buildAssistantWelcomeNoteContent,
} from './assistant-welcome-note';

describe('assistant-welcome-note compatibility alias', () => {
  it('renders the teammate template with legacy assistant identity params', () => {
    const content = buildAssistantWelcomeNoteContent({
      assistantName: 'Product/Design Agor Board',
      assistantEmoji: '🧋',
    });

    expect(ASSISTANT_WELCOME_NOTE_TEMPLATE).toContain('{{teammate.name}}');
    expect(content).not.toContain('{{teammate.name}}');
    expect(content).not.toContain('{{teammate.emoji}}');
    expect(content).toContain("Product/Design Agor Board's Board 🧋");
    expect(content).toContain('**Product/Design Agor Board**');
  });

  it('falls back to teammate defaults when name is empty and emoji is missing', () => {
    const content = buildAssistantWelcomeNoteContent({
      assistantName: '   ',
      assistantEmoji: null,
    });

    expect(content).toContain("your teammate's Board 🤖");
    expect(content).not.toContain('{{teammate.name}}');
    expect(content).not.toContain('{{teammate.emoji}}');
  });

  it('uses Handlebars double-stash escaping for HTML-looking values', () => {
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
