/**
 * Lazy-loaded wrapper around AppNode (a React Flow node type).
 *
 * AppNode statically imports `@codesandbox/sandpack-react` (~200KB). Wrapping
 * it in React.lazy keeps Sandpack off the board chunk so it is fetched only
 * when a board actually renders an app node, rather than for every board
 * regardless of whether it has app nodes.
 *
 * The fallback is a small neutral placeholder sized to fill the node so the
 * canvas doesn't jump while the Sandpack chunk downloads. The exported
 * component keeps AppNode's signature, so the `nodeTypes` map stays stable.
 */
import { lazy, Suspense } from 'react';
import type { AppNodeData } from './AppNode';
import { NodeLoadingPlaceholder } from './NodeLoadingPlaceholder';

const AppNodeInner = lazy(() => import('./AppNode').then((m) => ({ default: m.AppNode })));

export const AppNode = (props: { data: AppNodeData; selected?: boolean }) => (
  <Suspense
    fallback={
      <NodeLoadingPlaceholder
        title={props.data.title}
        width={props.data.width}
        height={props.data.height}
      />
    }
  >
    <AppNodeInner {...props} />
  </Suspense>
);
