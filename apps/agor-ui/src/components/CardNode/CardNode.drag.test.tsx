import type { CardWithType } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  REACT_FLOW_DRAG_HANDLE_SELECTOR,
  REACT_FLOW_NO_DRAG_CLASS,
} from '../../utils/reactFlowDragClasses';
import CardNode from './CardNode';

describe('CardNode drag handle', () => {
  it('makes the card header, not just the small drag icon, a drag handle', () => {
    render(
      <CardNode
        data={{
          card: {
            card_id: 'card-1',
            title: 'Planning card',
            effective_color: '#1677ff',
            effective_emoji: '📝',
            archived: false,
          } as unknown as CardWithType,
        }}
      />
    );

    const title = screen.getByText('Planning card');

    expect(title.closest(REACT_FLOW_DRAG_HANDLE_SELECTOR)).not.toBeNull();
    expect(title.closest(`.${REACT_FLOW_NO_DRAG_CLASS}`)).toBeNull();
  });
});
