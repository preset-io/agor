import { Tree, type TreeProps } from 'antd';
import { useLayoutEffect, useRef, useState } from 'react';
import { BRANCH_SESSION_VIEWPORT_HEIGHT } from './branchCardLayout';
import type { SessionTreeNode } from './buildSessionTree';

/** AntD needs a numeric height to virtualize; CSS alone only clips mounted rows. */
export function BranchSessionTree({
  fillAvailableHeight,
  onContentSizeChange,
  ...props
}: Omit<TreeProps<SessionTreeNode>, 'height' | 'virtual'> & {
  fillAvailableHeight: boolean;
  onContentSizeChange?: (contentHeight: number, viewportHeight: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(BRANCH_SESSION_VIEWPORT_HEIGHT);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!fillAvailableHeight || !viewport) return;
    // Measure the flex slot, not the tree content, so changing the virtual
    // window cannot grow its own container. Hidden tabs must not disable virtualization.
    // AntD exposes no total-height callback. Its scroll holder includes the
    // virtual spacer, so scrollHeight measures the whole collection, not just
    // mounted rows. Observe the spacer too: short lists can grow without
    // changing their currently capped viewport.
    const holder = viewport.querySelector<HTMLElement>('.ant-tree-list-holder');
    const measure = () => {
      const viewportHeight = viewport.clientHeight;
      setHeight(Math.max(1, viewportHeight));
      if (viewportHeight > 0 && holder) {
        onContentSizeChange?.(holder.scrollHeight, viewportHeight);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (holder) {
      observer.observe(holder);
      if (holder.firstElementChild) observer.observe(holder.firstElementChild);
    }
    return () => observer.disconnect();
  }, [fillAvailableHeight, onContentSizeChange]);

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
