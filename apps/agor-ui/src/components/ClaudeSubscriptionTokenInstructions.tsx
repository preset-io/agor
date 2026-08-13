import { Typography } from 'antd';

/** Shared guidance for obtaining the explicit Claude subscription token Agor stores. */
export const ClaudeSubscriptionTokenInstructions: React.FC = () => (
  <span>
    Run <Typography.Text code>claude setup-token</Typography.Text> in a terminal with Claude Code,
    authorize in the browser, then return to the terminal and paste the token printed there. The
    Anthropic page does not redirect back into Agor. If the command gets stuck, press{' '}
    <Typography.Text code>Ctrl+C</Typography.Text> and run it again; restarting the terminal should
    not be necessary. Need Claude Code?{' '}
    <Typography.Link href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank">
      Install docs
    </Typography.Link>
    .
  </span>
);
