import { describe, expect, it } from 'vitest';
import { sanitizePromptTaskMetadata } from './register-routes';

describe('prompt route metadata hardening', () => {
  it('strips caller-supplied upload link ids from task metadata', () => {
    expect(
      sanitizePromptTaskMetadata({
        source: 'agor',
        upload_link_ids: ['spoofed-link' as never],
        widget_id: 'widget-1',
      })
    ).toEqual({
      source: 'agor',
      widget_id: 'widget-1',
    });
  });
});
