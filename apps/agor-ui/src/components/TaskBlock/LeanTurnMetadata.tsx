import { MoreOutlined } from '@ant-design/icons';
import { Button, Flex, theme } from 'antd';
import { type ReactNode, useId, useState } from 'react';

/** Bottom overlay uses the existing footer space: no text occlusion or hover layout shift. */
export function LeanTurnMetadata({
  metadata,
  background,
  children,
}: {
  metadata: ReactNode;
  background?: string;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const visible = hovered || focused || pinned;
  return (
    <div
      style={{ position: 'relative', minWidth: 0, paddingBottom: token.controlHeight }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {children}
      <Flex
        align="center"
        gap={token.marginXS}
        style={{
          position: 'absolute',
          bottom: 0,
          insetInline: 0,
          zIndex: 1,
          height: token.controlHeight,
          minWidth: 0,
          borderRadius: token.borderRadius,
          background: visible ? token.colorBgElevated : undefined,
          boxShadow: visible ? token.boxShadowSecondary : undefined,
        }}
      >
        <Button
          type="text"
          size="small"
          icon={<MoreOutlined />}
          aria-label="Show turn metadata"
          aria-expanded={visible}
          aria-controls={id}
          aria-pressed={pinned}
          onClick={() => setPinned(!pinned)}
        />
        <section
          id={id}
          aria-label="Turn metadata"
          aria-hidden={!visible}
          style={{
            flex: 1,
            minWidth: 0,
            height: token.controlHeight,
            display: 'flex',
            alignItems: 'center',
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'thin',
            visibility: visible ? 'visible' : 'hidden',
            background,
            borderRadius: token.borderRadiusSM,
          }}
        >
          {metadata}
        </section>
      </Flex>
    </div>
  );
}
