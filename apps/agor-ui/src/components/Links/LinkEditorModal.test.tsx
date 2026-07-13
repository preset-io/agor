import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkEditorModal } from './LinkEditorModal';
import type { LinkDisplayItem } from './linkDisplay';

const parsedItem: LinkDisplayItem = {
  key: 'link:issue',
  linkId: 'issue-link',
  name: 'Issue: openai/codex#21295',
  targetKey: 'url:https://github.com/openai/codex/issues/21295',
  category: 'issue',
  kind: 'issue',
  source: 'parsed',
  ownerScope: 'session',
  isPinned: true,
  url: 'https://github.com/openai/codex/issues/21295',
};

describe('LinkEditorModal', () => {
  it('keeps derived labels implicit and source-owned targets read-only', async () => {
    render(
      <LinkEditorModal
        open
        item={parsedItem}
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => true)}
      />
    );

    expect(await screen.findByLabelText('Label')).toHaveValue('');
    expect(screen.getByLabelText('Target')).toHaveValue(parsedItem.url);
    expect(screen.getByLabelText('Target')).toBeDisabled();
  });
});
