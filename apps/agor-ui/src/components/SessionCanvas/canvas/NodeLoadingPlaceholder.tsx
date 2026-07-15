import { Flex, Typography, theme } from 'antd';

/**
 * Neutral fill placeholder shown while a lazily-loaded React Flow node (e.g.
 * the Sandpack-backed AppNode / ArtifactNode) downloads its chunk. Sized to
 * the node's final width/height so the canvas layout doesn't jump when the
 * real node mounts — app/artifact nodes don't set explicit React Flow node
 * dimensions, so without this the node would render at the placeholder's
 * intrinsic size and then reflow to `data.width`/`data.height`.
 */
export const NodeLoadingPlaceholder = ({
  title,
  width,
  height,
}: {
  title?: string;
  width?: number;
  height?: number;
}) => {
  const { token } = theme.useToken();

  return (
    <Flex
      align="center"
      justify="center"
      style={{
        width: width ?? '100%',
        height: height ?? '100%',
        minWidth: width ?? 120,
        minHeight: height ?? 80,
        boxSizing: 'border-box',
        padding: token.paddingXS,
        borderRadius: token.borderRadiusLG,
        border: `${token.lineWidth}px ${token.lineType} ${token.colorBorder}`,
        background: token.colorFillAlter,
        textAlign: 'center',
        overflow: 'hidden',
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {title ? `Loading ${title}…` : 'Loading…'}
      </Typography.Text>
    </Flex>
  );
};
