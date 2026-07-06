import type { Link } from '@agor-live/client';

export const LINK_MUTATION_EVENT = 'agor:link-mutation';

export type LinkMutationKind = 'created' | 'patched' | 'updated' | 'removed';

export interface LinkMutationEventDetail {
  link: Link;
  mutation: LinkMutationKind;
}

export function dispatchLinkMutation(detail: LinkMutationEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<LinkMutationEventDetail>(LINK_MUTATION_EVENT, { detail }));
}

export function listenForLinkMutations(
  handler: (detail: LinkMutationEventDetail) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<LinkMutationEventDetail>).detail;
    if (!detail?.link?.link_id) return;
    handler(detail);
  };

  window.addEventListener(LINK_MUTATION_EVENT, listener);
  return () => window.removeEventListener(LINK_MUTATION_EVENT, listener);
}
