import { Button, Flex, Result, theme } from 'antd';

/**
 * Full-page state for a workspace the daemon has closed to ordinary access.
 *
 * It replaces the whole app shell rather than decorating it: with the socket
 * intentionally disconnected, a mounted workspace would be a live-looking
 * canvas whose every prompt, terminal and upload fails.
 *
 * The screen deliberately names nothing. The packet asked for the Team name,
 * but the browser has no tenant display name without a new endpoint, and the
 * one label it does hold (`/health` `instance.label`) identifies the
 * deployment — on a shared Cell it is the Cell, not the Team. Everything else
 * the restriction record knows — why, who, which placement or revision — is
 * operator state and belongs on the operator's side of the boundary.
 */
export function WorkspaceSuspended({
  onRetry = () => window.location.reload(),
}: {
  onRetry?: () => void;
}) {
  const { token } = theme.useToken();

  return (
    <Flex
      vertical
      align="center"
      justify="center"
      style={{ minHeight: '100vh', backgroundColor: token.colorBgLayout }}
    >
      <Result
        status="warning"
        title="This workspace is suspended"
        subTitle="Contact your administrator"
        extra={<Button onClick={onRetry}>Try again</Button>}
      />
    </Flex>
  );
}
