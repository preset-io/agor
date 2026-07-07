import { describe, expect, it } from 'vitest';
import {
  getSelectAssistantPanelTabState,
  getShowCommentsPanelState,
  getToggleBoardPanelState,
} from './boardPanelActions';

describe('board panel navbar actions', () => {
  it('opens a closed panel on the Comments tab from Show comments tab', () => {
    expect(getShowCommentsPanelState({ collapsed: true, activeTab: 'assistant' })).toEqual({
      collapsed: false,
      activeTab: 'comments',
    });
  });

  it('selects Comments when Show comments tab is used from another open tab', () => {
    expect(getShowCommentsPanelState({ collapsed: false, activeTab: 'all-sessions' })).toEqual({
      collapsed: false,
      activeTab: 'comments',
    });
  });

  it('opens a closed panel on the Assistant tab from Toggle board panel', () => {
    expect(getToggleBoardPanelState({ collapsed: true, activeTab: 'comments' })).toEqual({
      collapsed: false,
      activeTab: 'assistant',
    });
  });

  it('preserves close behavior when Toggle board panel is used while open', () => {
    expect(getToggleBoardPanelState({ collapsed: false, activeTab: 'comments' })).toEqual({
      collapsed: true,
      activeTab: 'comments',
    });
  });

  it.each([
    'assistant',
    'all-sessions',
    'comments',
  ] as const)('opens a closed panel on the %s tab when its rail button is clicked', (tab) => {
    expect(getSelectAssistantPanelTabState(tab)).toEqual({
      collapsed: false,
      activeTab: tab,
    });
  });
});
