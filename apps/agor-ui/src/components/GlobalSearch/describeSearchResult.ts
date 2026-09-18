import { getTeammateConfig } from '@agor-live/client';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTimeSafe } from '../../utils/time';
import type { SearchResultItem } from './types';

interface SearchResultDescription {
  title: string;
  tag?: string;
  secondary?: string;
  time?: string;
  /** Only set when the entity itself has an emoji (teammate config); section headers carry the kind. */
  icon?: string;
}

/** Display fields for a search result row, shared by the desktop palette and the mobile search screen. */
export function describeSearchResult(result: SearchResultItem): SearchResultDescription {
  switch (result.type) {
    case 'session': {
      const title = getSessionDisplayTitle(result.item, { includeAgentFallback: true });
      return {
        title,
        tag: result.item.agentic_tool,
        secondary: result.parentBranch ? `in ${result.parentBranch.name}` : undefined,
        time: formatRelativeTimeSafe(result.item.last_updated),
      };
    }
    case 'branch': {
      return {
        title: result.item.name,
        tag: result.item.ref,
        time: formatRelativeTimeSafe(result.item.updated_at),
      };
    }
    case 'teammate': {
      const config = getTeammateConfig(result.item);
      return {
        icon: config?.emoji,
        title: config?.displayName ?? result.item.name,
        time: formatRelativeTimeSafe(result.item.updated_at),
      };
    }
    case 'artifact': {
      return {
        title: result.item.name,
        tag: result.item.template,
        secondary: result.parentBranch ? `in ${result.parentBranch.name}` : undefined,
        time: formatRelativeTimeSafe(result.item.updated_at),
      };
    }
    case 'board': {
      return {
        title: result.item.name,
        time: formatRelativeTimeSafe(result.item.last_updated),
      };
    }
    case 'mcp': {
      return {
        title: result.item.display_name || result.item.name,
        tag: result.item.transport,
        secondary: result.item.description,
      };
    }
  }
}
