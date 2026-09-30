import { Flex, Typography, theme } from 'antd';
import type { TeammateOption } from '../../utils/teammateLabels';

/** One line: emoji, name, then the board in regular secondary text. */
export const TeammateOptionLabel: React.FC<{ option: TeammateOption }> = ({ option }) => {
  const { token } = theme.useToken();
  return (
    <Flex gap={token.marginXS} align="center" style={{ minWidth: 0 }}>
      <span aria-hidden>{option.emoji}</span>
      <Typography.Text ellipsis={{ tooltip: option.label }} style={{ flex: '0 1 auto' }}>
        {option.label}
      </Typography.Text>
      {option.context && (
        <Typography.Text
          type="secondary"
          ellipsis={{ tooltip: option.context }}
          style={{ fontWeight: 'normal' }}
        >
          {option.context}
        </Typography.Text>
      )}
    </Flex>
  );
};
