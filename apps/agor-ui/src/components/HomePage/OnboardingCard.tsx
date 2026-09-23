import { CheckOutlined } from '@ant-design/icons';
import { Button, Flex, theme } from 'antd';
import type React from 'react';
import { HomeBlock, HomeLink } from './HomeBlock';

export interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
  cta: string;
  href?: string;
  onClick?: () => void;
}

interface OnboardingCardProps {
  steps: OnboardingStep[];
  onDismiss: () => void;
}

export const OnboardingCard: React.FC<OnboardingCardProps> = ({ steps, onDismiss }) => {
  const { token } = theme.useToken();
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <HomeBlock
      label="Get started with Agor"
      count={`${doneCount}/${steps.length}`}
      surface
      actions={<HomeLink onClick={onDismiss}>Don't show again</HomeLink>}
    >
      {steps.map((step) => (
        <Flex
          key={step.id}
          align="center"
          gap={token.marginXS}
          style={{ minHeight: token.controlHeight, paddingInline: token.paddingXS }}
        >
          <span
            aria-hidden
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              flex: '0 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: step.done ? token.colorPrimary : 'transparent',
              border: step.done ? 'none' : `${token.lineWidth}px solid ${token.colorBorder}`,
            }}
          >
            {step.done && (
              <CheckOutlined style={{ fontSize: 8, color: token.colorTextLightSolid }} />
            )}
          </span>
          <span
            style={{
              flex: 1,
              fontSize: 13,
              color: step.done ? token.colorTextTertiary : token.colorText,
              textDecoration: step.done ? 'line-through' : 'none',
            }}
          >
            {step.label}
          </span>
          {!step.done && (
            <Button
              type="link"
              size="small"
              href={step.onClick ? undefined : step.href}
              onClick={step.onClick}
              style={{ padding: 0, fontSize: token.fontSizeSM, height: 'auto' }}
            >
              {step.cta}
            </Button>
          )}
        </Flex>
      ))}
    </HomeBlock>
  );
};
