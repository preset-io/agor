import { Drawer, type DrawerProps, Flex, theme } from 'antd';
import { MARKETPLACE_CATALOG_DRAWER_WIDTH } from './marketplaceLayout';

type Props = Pick<
  DrawerProps,
  'open' | 'onClose' | 'afterOpenChange' | 'title' | 'aria-labelledby' | 'children'
>;

/**
 * One presentation seam for Catalog detail/auth and pre-selection states.
 * Context owners supply content/callbacks, not drawer spacing overrides.
 * AntD owns header/body padding and responsive width; actions remain in the
 * body flow (there is no separate padded footer in either context).
 */
export function CatalogDrawer({ children, ...props }: Props) {
  const { token } = theme.useToken();
  return (
    <Drawer {...props} size={MARKETPLACE_CATALOG_DRAWER_WIDTH} destroyOnHidden>
      <Flex vertical gap={token.margin}>
        {children}
      </Flex>
    </Drawer>
  );
}
