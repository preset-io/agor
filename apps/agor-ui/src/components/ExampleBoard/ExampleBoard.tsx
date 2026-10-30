import { PRODUCT_ANALYTICS_EVENTS } from '@agor-live/client';
import { Alert, Button, Flex, Typography, theme } from 'antd';
import { useEffect } from 'react';
import { useExampleBoardActions } from '../../contexts/ExampleBoardContext';
import { trackProductEvent } from '../../utils/productAnalytics';

/** Slim notice under the board header of the read-only example board. */
export const ExampleBoardBanner: React.FC<{ boardId: string }> = ({ boardId }) => {
  const actions = useExampleBoardActions();
  const userId = actions?.userId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one event per board opened
  useEffect(() => {
    trackProductEvent(userId, { event: PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_OPENED });
  }, [boardId, userId]);

  return (
    <Alert
      type="info"
      showIcon
      banner
      // Buttons share the message row so they wrap below the text on phones instead of squeezing it.
      title={
        <Flex align="center" justify="space-between" gap="small" wrap>
          <span>This is an example board with made-up data. Look around, nothing here runs.</span>
          {actions && (
            <Flex gap="small">
              {actions.makeYourOwn && (
                <Button type="primary" size="small" onClick={() => actions.makeYourOwn?.('banner')}>
                  Make your own
                </Button>
              )}
              <Button type="text" size="small" onClick={actions.hide}>
                Hide example
              </Button>
            </Flex>
          )}
        </Flex>
      }
      style={{ flexShrink: 0 }}
    />
  );
};

/** Replaces the composer on example sessions. */
export const ExampleSessionFooter: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { token } = theme.useToken();
  const actions = useExampleBoardActions();
  const userId = actions?.userId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one event per session opened
  useEffect(() => {
    trackProductEvent(userId, {
      event: PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_OBJECT_OPENED,
      object: 'session',
    });
  }, [sessionId, userId]);

  return (
    <Flex
      align="center"
      justify="space-between"
      gap="small"
      wrap
      style={{
        flexShrink: 0,
        padding: `${token.paddingSM}px ${token.padding}px`,
        borderTop: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
      }}
    >
      <Typography.Text type="secondary">
        Example session. Start your own to try this.
      </Typography.Text>
      {actions?.makeYourOwn && (
        <Button type="primary" onClick={() => actions.makeYourOwn?.('session')}>
          Make your own
        </Button>
      )}
    </Flex>
  );
};
