/**
 * Lazy-loaded wrapper around AppNode (a React Flow node type).
 *
 * AppNode statically imports `@codesandbox/sandpack-react` (~200KB). It used
 * to be imported eagerly by SessionCanvas, so Sandpack landed in the board
 * chunk even for boards that have no app nodes. Wrapping it in React.lazy
 * means Sandpack is fetched only when a board actually renders an app node.
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
