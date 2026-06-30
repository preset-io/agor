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
}) => (
  <div
    style={{
      width: width ?? '100%',
      height: height ?? '100%',
      minWidth: width ?? 120,
      minHeight: height ?? 80,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box',
      padding: 8,
      borderRadius: 8,
      border: '1px solid var(--ant-color-border, #424242)',
      background: 'var(--ant-color-fill-alter, rgba(255,255,255,0.02))',
      color: 'var(--ant-color-text-secondary, #888)',
      fontSize: 12,
      textAlign: 'center',
      overflow: 'hidden',
    }}
  >
    {title ? `Loading ${title}…` : 'Loading…'}
  </div>
);
