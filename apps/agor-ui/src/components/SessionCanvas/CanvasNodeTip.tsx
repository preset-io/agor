import { AimOutlined } from '@ant-design/icons';
import { Flex, Popover, theme } from 'antd';
import { type Node, useStore } from 'reactflow';

export interface CanvasNodeTipTarget {
  /** A React Flow node id, or an artifact id (found through `data.artifactId`). */
  nodeId: string;
  text: string;
}

/**
 * An open popover over the top of a canvas node, following it as the camera
 * pans. Rendered inside `<ReactFlow>` so it can read the node and viewport.
 */
export const CanvasNodeTip: React.FC<{ tip: CanvasNodeTipTarget }> = ({ tip }) => {
  const { token } = theme.useToken();
  const anchor = useStore((state) => {
    const nodes = state.getNodes() as Node[];
    const node =
      state.nodeInternals.get(tip.nodeId) ??
      nodes.find((candidate) => candidate.data?.artifactId === tip.nodeId);
    const position = node?.positionAbsolute ?? node?.position;
    if (!node || !position) return null;
    const [x, y, zoom] = state.transform;
    return `${x + (position.x + (node.width ?? 0) / 2) * zoom},${y + position.y * zoom}`;
  });
  if (!anchor) return null;
  const [left, top] = anchor.split(',').map(Number);
  return (
    <Popover
      open
      placement="top"
      content={
        <Flex align="center" gap={token.marginXS} style={{ maxWidth: 320 }}>
          <AimOutlined style={{ color: token.colorPrimary }} />
          <span>{tip.text}</span>
        </Flex>
      }
    >
      <span
        aria-hidden
        style={{ position: 'absolute', left, top, width: 0, height: 0, pointerEvents: 'none' }}
      />
    </Popover>
  );
};
