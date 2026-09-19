import type { Branch, Session } from '@agor-live/client';
import { useNavigate } from 'react-router-dom';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { StatusPill } from '../Pill';
import { MobileListRow } from './MobileListRow';

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
  const title = getSessionDisplayTitle(session, { fallbackChars: 40 });
  return (
    <MobileListRow
      title={title}
      subtitle={[branch?.name, session.model_config?.model].filter(Boolean).join(' · ')}
      ariaLabel={`Open ${title}`}
      onPress={() => navigate(`/m/session/${session.session_id}`)}
      trailing={<StatusPill status={session.status} />}
    />
  );
};
