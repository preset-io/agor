/**
 * Neutral fill placeholder shown while a lazily-loaded React Flow node (e.g.
 * the Sandpack-backed AppNode / ArtifactNode) downloads its chunk. Fills the
 * node box so the canvas layout doesn't jump.
 */
export const NodeLoadingPlaceholder = ({ title }: { title?: string }) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      minWidth: 120,
      minHeight: 80,
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
