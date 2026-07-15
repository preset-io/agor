import { Typography } from 'antd';

/** Shared guidance for obtaining the explicit Claude subscription token Agor stores. */
export const ClaudeSubscriptionTokenInstructions: React.FC = () => (
  <span>
    In any terminal with Claude Code installed, run{' '}
    <Typography.Text code>claude setup-token</Typography.Text>, then paste the printed token here.
    Need Claude Code?{' '}
    <Typography.Link href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank">
      Install docs
    </Typography.Link>
    .
  </span>
);
