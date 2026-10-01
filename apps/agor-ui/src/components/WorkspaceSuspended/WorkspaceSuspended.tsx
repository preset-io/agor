import { Button, Flex, Result, theme } from 'antd';

/** Full-page closed-workspace state replacing the shell; it names nothing, since restriction details are operator state. */
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
