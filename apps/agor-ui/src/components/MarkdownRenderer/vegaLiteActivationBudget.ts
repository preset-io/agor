import { createContext } from 'react';

export interface VegaLiteActivationBudget {
  sourceIdentity: string;
  claim(id: string): boolean;
}

// A custom renderer used without an owning MarkdownRenderer must not silently
// lose the document-level resource boundary.
export const VegaLiteActivationBudgetContext = createContext<VegaLiteActivationBudget | null>(null);

/**
 * A budget belongs to one Markdown source and counts actual custom-renderer
 * activations, not approximations of Markdown syntax. Claims are stable by
 * React id so effect replays do not consume additional slots.
 */
export function createVegaLiteActivationBudget(
  maxActivations: number,
  sourceIdentity: string
): VegaLiteActivationBudget {
  const claimedIds = new Set<string>();
  return {
    sourceIdentity,
    claim(id) {
      if (claimedIds.has(id)) return true;
      if (claimedIds.size >= maxActivations) return false;
      claimedIds.add(id);
      return true;
    },
  };
}
