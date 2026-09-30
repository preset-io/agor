import { Flex, Typography, theme } from 'antd';
import type { TeammateOption } from '../../utils/teammateLabels';

/** One line: emoji, name, then the board in regular secondary text; the board truncates first but keeps room for its ellipsis. */
export const TeammateOptionLabel: React.FC<{ option: TeammateOption }> = ({ option }) => {
  const { token } = theme.useToken();
  return (
    <Flex gap={token.marginXS} align="center" style={{ minWidth: 0 }}>
      <span aria-hidden style={{ flex: 'none' }}>
        {option.emoji}
      </span>
      <Typography.Text
        ellipsis={{ tooltip: option.label }}
        style={{ flex: '0 1 auto', minWidth: 0 }}
      >
        {option.label}
      </Typography.Text>
      {option.context && (
        <Typography.Text
          type="secondary"
          ellipsis={{ tooltip: option.context }}
          style={{ flex: '1 1 0%', minWidth: '3em', fontWeight: 'normal' }}
        >
          {option.context}
        </Typography.Text>
      )}
    </Flex>
  );
};
