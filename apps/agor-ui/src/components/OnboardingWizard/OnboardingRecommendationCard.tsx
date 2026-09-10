import { Button, type ButtonProps, Card, Checkbox, Flex, Typography, theme } from 'antd';
import { type ReactNode, useId } from 'react';
import type { OnboardingIntegrationRecommendation } from '../../utils/onboardingGoals';
import { McpLogo } from '../McpLogo';

/** Shared hierarchy for optional MCP connections and gateway recommendations. */
export function OnboardingRecommendationCard({
  recommendation: rec,
  name = rec.name,
  titleExtra,
  descriptionId,
  selected,
  onToggle,
  listItem = false,
  children,
}: {
  recommendation: OnboardingIntegrationRecommendation;
  name?: string;
  titleExtra?: ReactNode;
  descriptionId: string;
  selected: boolean;
  onToggle: () => void;
  listItem?: boolean;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  const titleId = useId();
  return (
    <Card
      role={listItem ? 'listitem' : undefined}
      aria-labelledby={titleId}
      size="small"
      styles={{ body: { padding: token.paddingSM } }}
    >
      <Flex align="flex-start" gap={token.marginSM}>
        <Flex
          align="center"
          justify="center"
          style={{ width: token.controlHeightSM, height: token.controlHeightSM, flexShrink: 0 }}
        >
          <McpLogo id={rec.id} name={rec.name} size={token.sizeMD} color={token.colorText} />
        </Flex>
        <Flex vertical gap={token.marginXXS} style={{ minWidth: 0, flex: 1 }}>
          <Flex align="flex-start" gap="small">
            <Flex align="center" wrap gap={token.marginXS} style={{ minWidth: 0, flex: 1 }}>
              <Typography.Text
                id={titleId}
                strong
                style={{ fontSize: token.fontSize, minWidth: 0, overflowWrap: 'anywhere' }}
              >
                {name}
              </Typography.Text>
              {titleExtra}
            </Flex>
            <Checkbox
              aria-label={`Suggest ${rec.name} to my teammate`}
              aria-describedby={descriptionId}
              checked={selected}
              onChange={onToggle}
              style={{ flexShrink: 0 }}
            />
          </Flex>
          <Typography.Text
            id={descriptionId}
            type="secondary"
            style={{
              fontSize: token.fontSizeSM,
              lineHeight: token.lineHeightSM,
              overflowWrap: 'anywhere',
            }}
          >
            {rec.description}
          </Typography.Text>
          {children}
        </Flex>
      </Flex>
    </Card>
  );
}

export function OnboardingToolAction(props: ButtonProps) {
  const { token } = theme.useToken();
  return (
    <Button
      {...props}
      type="link"
      style={{
        alignSelf: 'flex-start',
        paddingLeft: 0,
        paddingInlineStart: 0,
        // Keep the visible link a token gap below the preceding line.
        // The touch target extends below its line, not above it.
        paddingBlock: 0,
        border: 'none',
        alignItems: 'flex-start',
        lineHeight: token.lineHeightSM,
        whiteSpace: 'normal',
        height: 'auto',
        minHeight: token.controlHeight,
        fontSize: token.fontSizeSM,
        textAlign: 'left',
      }}
    />
  );
}
