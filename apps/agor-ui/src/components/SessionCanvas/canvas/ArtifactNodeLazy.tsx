/**
 * Lazy-loaded wrapper around ArtifactNode (a React Flow node type).
 *
 * ArtifactNode statically imports `@codesandbox/sandpack-react` (~200KB,
 * shared with AppNode). It used to be imported eagerly by SessionCanvas, so
 * Sandpack landed in the board chunk even for boards with no artifact nodes.
 * Wrapping it in React.lazy means Sandpack is fetched only when a board
 * actually renders an artifact node.
 *
 * The exported component keeps ArtifactNode's signature so the `nodeTypes`
 * map stays stable; the fallback fills the node box to avoid layout jank.
 */
import { lazy, Suspense } from 'react';
import type { ArtifactNodeData } from './ArtifactNode';
import { NodeLoadingPlaceholder } from './NodeLoadingPlaceholder';

const ArtifactNodeInner = lazy(() =>
  import('./ArtifactNode').then((m) => ({ default: m.ArtifactNode }))
);

export const ArtifactNode = (props: { data: ArtifactNodeData; selected?: boolean }) => (
  <Suspense
    fallback={<NodeLoadingPlaceholder width={props.data.width} height={props.data.height} />}
  >
    <ArtifactNodeInner {...props} />
  </Suspense>
);
