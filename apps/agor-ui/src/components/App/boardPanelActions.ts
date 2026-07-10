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

// Used by every AssistantPanelRail button when the panel is collapsed:
// expand onto whichever tab was clicked.
export const getSelectAssistantPanelTabState = (
  tab: BoardAssistantPanelTab
): BoardLeftPanelState => ({
  collapsed: false,
  activeTab: tab,
});
