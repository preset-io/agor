/**
 * Lazy-loaded wrapper around AppNode (a React Flow node type).
 *
 * AppNode statically imports `@codesandbox/sandpack-react` (~200KB). Wrapping
 * it in React.lazy keeps Sandpack off the board chunk so it is fetched only
 * when a board actually renders an app node, rather than for every board
 * regardless of whether it has app nodes.
 *
 * The node also stays a placeholder until it first enters the viewport, so
 * offscreen apps don't boot the Sandpack bundler (network + CPU heavy) while
 * the board is still painting after a navigation (#1768).
 *
 * The fallback is a small neutral placeholder sized to fill the node so the
 * canvas doesn't jump while the Sandpack chunk downloads. The exported
 * component keeps AppNode's signature, so the `nodeTypes` map stays stable.
 */
import { lazy, Suspense, useRef } from 'react';
import { useInViewportOnce } from '../../../hooks/useInViewportOnce';
import type { AppNodeData } from './AppNode';
import { NodeLoadingPlaceholder } from './NodeLoadingPlaceholder';

const AppNodeInner = lazy(() => import('./AppNode').then((m) => ({ default: m.AppNode })));

export const AppNode = (props: { data: AppNodeData; selected?: boolean }) => {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInViewportOnce(ref);
  const placeholder = (
    <NodeLoadingPlaceholder
      title={props.data.title}
      width={props.data.width}
      height={props.data.height}
    />
  );
  return (
    <div ref={ref}>
      {seen ? (
        <Suspense fallback={placeholder}>{<AppNodeInner {...props} />}</Suspense>
      ) : (
        placeholder
      )}
    </div>
  );
};
