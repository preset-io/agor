import type { Branch, Session } from '@agor-live/client';
import { List, Typography, theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { pressableProps } from '../../utils/pressableProps';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { StatusPill } from '../Pill';

interface MobileSessionRowProps {
  session: Session;
  branch?: Branch;
}

/**
 * Shared session list row (title + branch/model subtitle + StatusPill) for every
 * mobile session list: Sessions, Home, and Board branch cards. Tapping opens the
 * full-screen session view. Keyboard-operable.
 */
export const MobileSessionRow: React.FC<MobileSessionRowProps> = ({ session, branch }) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const title = getSessionDisplayTitle(session, { fallbackChars: 40 });
  const subtitle = [branch?.name, session.model_config?.model].filter(Boolean).join(' · ');
  const open = () => navigate(`/m/session/${session.session_id}`);

  return (
    <List.Item
      {...pressableProps(open)}
      aria-label={`Open ${title}`}
      style={{ cursor: 'pointer', paddingInline: 0, minHeight: MOBILE_TOUCH_TARGET }}
    >
      <List.Item.Meta
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
      <StatusPill status={session.status} />
    </List.Item>
  );
};
