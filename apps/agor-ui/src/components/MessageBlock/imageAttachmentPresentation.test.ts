import type { UrlImageContentBlock } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { hidePreviewedImageAttachments } from './imageAttachmentPresentation';

const chartPreview: UrlImageContentBlock = {
  type: 'image',
  url: '/sessions/session-1/tasks/task-1/images/0',
  filename: 'chart.png',
  media_type: 'image/png',
};
const diagramPreview: UrlImageContentBlock = {
  ...chartPreview,
  url: '/sessions/session-1/tasks/task-1/images/1',
  filename: 'diagram.webp',
  media_type: 'image/webp',
};

describe('hidePreviewedImageAttachments', () => {
  it('hides image-only attachment boilerplate while preserving the body', () => {
    expect(
      hidePreviewedImageAttachments(
        'Attached files:\n- /uploads/chart.png\n- /uploads/diagram.webp\n\nCompare these images',
        [chartPreview, diagramPreview]
      )
    ).toBe('Compare these images');
  });

  it('keeps the header and non-image entries in a mixed attachment list', () => {
    expect(
      hidePreviewedImageAttachments(
        'Attached files:\n- /uploads/chart.png\n- /uploads/notes.pdf\n\nCompare both files',
        [chartPreview]
      )
    ).toBe('Attached files:\n- /uploads/notes.pdf\n\nCompare both files');
  });

  it('leaves attachment-like text untouched when there is no image block', () => {
    const text = 'Attached files:\n- /uploads/chart.png\n\nCompare this chart';

    expect(hidePreviewedImageAttachments(text, [])).toBe(text);
  });

  it('retains ambiguous attachment entries that share a previewed basename', () => {
    const text = 'Attached files:\n- /first/chart.png\n- /second/chart.png\n\nCompare these charts';

    expect(hidePreviewedImageAttachments(text, [chartPreview])).toBe(text);
  });
});
