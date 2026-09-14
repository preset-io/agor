import { RightOutlined } from '@ant-design/icons';
import { Collapse, theme } from 'antd';
import type { ReactNode } from 'react';

/**
 * Disclosure headers are Collapse controls, not flush-left text actions.
 * Preserve the pre-tryout drawer's token spacing (12px header / 16px body)
 * through AntD's public semantics; AntD owns arrow alignment and keyboard focus.
 */
export function CatalogDetailSection({
  label,
  defaultOpen = false,
  children,
}: {
  label: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <Collapse
      expandIcon={({ isActive }) => <RightOutlined aria-hidden rotate={isActive ? 90 : 0} />}
      defaultActiveKey={defaultOpen ? ['details'] : []}
      styles={{
        header: { padding: token.paddingSM },
        body: { padding: token.padding },
      }}
      items={[
        {
          key: 'details',
          label,
          children,
          // rc-collapse handles Enter but not Space on its role=button header.
          // Limit this native-button parity shim to that header, never panel inputs.
          onKeyDown: (event) => {
            const target = event.target as HTMLElement;
            if (
              event.key === ' ' &&
              target.parentElement === event.currentTarget &&
              target.getAttribute('role') === 'button'
            ) {
              event.preventDefault();
              if (!event.repeat) target.click();
            }
          },
        },
      ]}
    />
  );
}
