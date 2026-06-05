import type { BoardAssistantPanelTab } from '../BoardAssistantPanel';

export interface BoardLeftPanelState {
  collapsed: boolean;
  activeTab: BoardAssistantPanelTab;
}

export const getShowCommentsPanelState = (state: BoardLeftPanelState): BoardLeftPanelState => ({
  ...state,
  collapsed: false,
  activeTab: 'comments',
});

export const getToggleBoardPanelState = (state: BoardLeftPanelState): BoardLeftPanelState => {
  if (state.collapsed) {
    return {
      collapsed: false,
      activeTab: 'assistant',
    };
  }

  return {
    ...state,
    collapsed: true,
  };
};
