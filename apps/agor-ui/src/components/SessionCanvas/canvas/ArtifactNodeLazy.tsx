/**
 * Lazy-loaded wrapper around ArtifactNode (a React Flow node type).
 *
 * ArtifactNode statically imports `@codesandbox/sandpack-react` (~200KB,
 * shared with AppNode). Wrapping it in React.lazy keeps Sandpack off the board
 * chunk so it is fetched only when a board actually renders an artifact node,
 * rather than for every board regardless of whether it has artifact nodes.
 *
 * The node also stays a placeholder until it first enters the viewport, so
 * offscreen artifacts don't boot the Sandpack bundler (network + CPU heavy)
 * while the board is still painting after a navigation (#1768).
 *
 * The exported component keeps ArtifactNode's signature so the `nodeTypes`
 * map stays stable; the fallback fills the node box to avoid layout jank.
 */
import { lazy, Suspense, useRef } from 'react';
import { useInViewportOnce } from '../../../hooks/useInViewportOnce';
import type { ArtifactNodeData } from './ArtifactNode';
import { NodeLoadingPlaceholder } from './NodeLoadingPlaceholder';

const ArtifactNodeInner = lazy(() =>
  import('./ArtifactNode').then((m) => ({ default: m.ArtifactNode }))
);

export const ArtifactNode = (props: { data: ArtifactNodeData; selected?: boolean }) => {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInViewportOnce(ref);
  const placeholder = (
    <NodeLoadingPlaceholder width={props.data.width} height={props.data.height} />
  );
  return (
    <div ref={ref}>
      {seen ? (
        <Suspense fallback={placeholder}>{<ArtifactNodeInner {...props} />}</Suspense>
      ) : (
        placeholder
      )}
    </div>
  );
};
