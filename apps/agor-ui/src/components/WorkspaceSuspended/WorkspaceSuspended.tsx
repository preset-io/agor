import { Flex, Result, Typography, theme } from 'antd';

interface Props {
  /**
   * The workspace's own label, so a member with several open workspaces can
   * tell which one this is. Everything else about the restriction — why it was
   * applied, who applied it, which placement or revision it belongs to — is
   * operator state and is deliberately absent from this screen.
   */
  workspaceName?: string;
}

/**
 * Full-page state for a workspace the daemon has closed to ordinary access.
 *
 * It replaces the whole app shell rather than decorating it: with the socket
 * intentionally disconnected, a mounted workspace would be a live-looking
 * canvas whose every prompt, terminal and upload fails.
 */
export function WorkspaceSuspended({ workspaceName }: Props) {
  const { token } = theme.useToken();

  return (
    <Flex
      vertical
      align="center"
      justify="center"
      style={{ minHeight: '100vh', backgroundColor: token.colorBgLayout }}
    >
      {workspaceName && <Typography.Text type="secondary">{workspaceName}</Typography.Text>}
      <Result
        status="warning"
        title="This workspace is suspended"
        subTitle="Contact your administrator"
      />
    </Flex>
  );
}
