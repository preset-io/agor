import { Tree, type TreeProps } from 'antd';
import { useLayoutEffect, useRef, useState } from 'react';
import { BRANCH_SESSION_VIEWPORT_HEIGHT } from './branchCardLayout';
import type { SessionTreeNode } from './buildSessionTree';

/** AntD needs a numeric height to virtualize; CSS alone only clips mounted rows. */
export function BranchSessionTree({
  fillAvailableHeight,
  ...props
}: TreeProps<SessionTreeNode> & { fillAvailableHeight: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(BRANCH_SESSION_VIEWPORT_HEIGHT);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!fillAvailableHeight || !viewport) return;
    // Measure the flex slot, not the tree content, so changing the virtual
    // window cannot grow its own container. Hidden tabs must not disable virtualization.
    const measure = () => setHeight(Math.max(1, viewport.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fillAvailableHeight]);

  const tree = (
    <Tree
      {...props}
      height={fillAvailableHeight ? height : BRANCH_SESSION_VIEWPORT_HEIGHT}
      virtual
    />
  );
  return fillAvailableHeight ? (
    <div ref={viewportRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {tree}
    </div>
  ) : (
    tree
  );
}
