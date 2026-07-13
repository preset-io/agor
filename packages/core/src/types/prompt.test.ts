import { describe, expect, it } from 'vitest';
import { buildPromptWithAttachments } from './prompt';

describe('buildPromptWithAttachments', () => {
  it('returns trimmed text when no attachments are present', () => {
    expect(buildPromptWithAttachments('  hello  ', [])).toBe('hello');
  });

  it('prepends attachments to a regular prompt', () => {
    expect(buildPromptWithAttachments('look at this', ['/tmp/a.png'])).toBe(
      'Attached files:\n- /tmp/a.png\n\nlook at this'
    );
  });

  it('keeps slash commands first', () => {
    expect(buildPromptWithAttachments('/review', ['/tmp/a.png'])).toBe(
      '/review\n\nAttached files:\n- /tmp/a.png'
    );
  });

  it('supports attachment-only prompts', () => {
    expect(buildPromptWithAttachments(' ', ['/tmp/a.png', '/tmp/b.png'])).toBe(
      'Attached files:\n- /tmp/a.png\n- /tmp/b.png'
    );
  });
});
