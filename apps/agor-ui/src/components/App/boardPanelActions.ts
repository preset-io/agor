import type { BoardTeammatePanelTab } from '../BoardTeammatePanel';

export interface BoardLeftPanelState {
  collapsed: boolean;
  activeTab: BoardTeammatePanelTab;
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
      activeTab: 'teammate',
    };
  }

  return {
    ...state,
    collapsed: true,
  };
};

// Used by every TeammatePanelRail button when the panel is collapsed:
// expand onto whichever tab was clicked.
export const getSelectTeammatePanelTabState = (
  tab: BoardTeammatePanelTab
): BoardLeftPanelState => ({
  collapsed: false,
  activeTab: tab,
});
