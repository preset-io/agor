import { List, Typography, theme } from 'antd';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { pressableProps } from '../../utils/pressableProps';

interface MobileListRowProps {
  title: string;
  subtitle?: string;
  ariaLabel: string;
  onPress: () => void;
  avatar?: React.ReactNode;
  /** Rendered after the text, e.g. a status pill or chevron. */
  trailing?: React.ReactNode;
  /** Adds the page gutter, for lists that are not already inside a padded card. */
  inset?: boolean;
}

/** Touch-sized, keyboard-operable list row: ellipsised title, optional secondary line, optional trailing element. */
export const MobileListRow: React.FC<MobileListRowProps> = ({
  title,
  subtitle,
  ariaLabel,
  onPress,
  avatar,
  trailing,
  inset = false,
}) => {
  const { token } = theme.useToken();
  return (
    <List.Item
      {...pressableProps(onPress)}
      aria-label={ariaLabel}
      style={{
        cursor: 'pointer',
        paddingInline: inset ? token.padding : 0,
        minHeight: MOBILE_TOUCH_TARGET,
      }}
    >
      <List.Item.Meta
        avatar={avatar}
        title={
          <Typography.Text ellipsis style={{ maxWidth: '100%' }}>
            {title}
          </Typography.Text>
        }
        description={
          subtitle ? (
            <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
              {subtitle}
            </Typography.Text>
          ) : undefined
        }
      />
      {trailing}
    </List.Item>
  );
};
