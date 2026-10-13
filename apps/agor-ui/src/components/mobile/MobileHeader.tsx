import { ArrowLeftOutlined } from '@ant-design/icons';
import { Button, Layout, Typography, theme } from 'antd';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';

const { Header } = Layout;
const { Title } = Typography;

interface MobileHeaderProps {
  title?: string;
  /** When set, a back arrow appears on the left. */
  onBack?: () => void;
}

/** Sub-page header (Back + title). Tab root screens have no header. */
export const MobileHeader: React.FC<MobileHeaderProps> = ({ title, onBack }) => {
  const { token } = theme.useToken();

  return (
    <Header
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: token.marginXS,
        paddingInline: token.padding,
        background: token.colorBgContainer,
        borderBottom: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
      }}
    >
      {onBack && (
        <Button
          type="text"
          aria-label="Back"
          icon={<ArrowLeftOutlined />}
          onClick={onBack}
          style={{
            minWidth: MOBILE_TOUCH_TARGET,
            minHeight: MOBILE_TOUCH_TARGET,
            marginInlineStart: -token.marginXS,
          }}
        />
      )}
      <Title
        level={5}
        ellipsis
        style={{ margin: 0, flex: 1, minWidth: 0, fontSize: token.fontSizeLG, fontWeight: 500 }}
      >
        {title || 'agor'}
      </Title>
    </Header>
  );
};
