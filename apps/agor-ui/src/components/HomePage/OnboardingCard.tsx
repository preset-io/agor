import { CheckOutlined } from '@ant-design/icons';
import { Button, Progress, Typography, theme } from 'antd';
import type React from 'react';
import { glassCardStyle } from './homeStyles';

const { Text } = Typography;

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
  const percent = steps.length === 0 ? 0 : Math.round((doneCount / steps.length) * 100);

  return (
    <div
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        padding: '16px 20px',
        marginBottom: 24,
        ...glassCardStyle(token, 0.3),
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <Text strong style={{ fontSize: 14, flex: 1 }}>
          Get started with Agor
        </Text>
        <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
          {doneCount}/{steps.length}
        </Text>
        <Progress
          percent={percent}
          showInfo={false}
          style={{ width: 60, margin: 0, flexShrink: 0 }}
          size="small"
          strokeColor={token.colorPrimary}
        />
      </div>

      {/* Steps */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {steps.map((step) => (
          <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Check circle */}
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: step.done ? token.colorPrimary : 'transparent',
                border: step.done ? 'none' : `1.5px solid ${token.colorBorderSecondary}`,
              }}
            >
              {step.done && (
                <CheckOutlined style={{ fontSize: 9, color: token.colorTextLightSolid }} />
              )}
            </span>

            {/* Label */}
            <Text
              style={{
                fontSize: 14,
                flex: 1,
                color: step.done ? token.colorTextTertiary : token.colorText,
                textDecoration: step.done ? 'line-through' : 'none',
              }}
            >
              {step.label}
            </Text>

            {/* CTA (only when not done) */}
            {!step.done && (
              <Button
                type="link"
                size="small"
                href={step.onClick ? undefined : step.href}
                onClick={step.onClick}
                style={{ padding: 0, fontSize: 12, height: 'auto' }}
              >
                {step.cta}
              </Button>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ marginTop: 12 }}>
        <Button
          type="text"
          size="small"
          onClick={onDismiss}
          style={{
            padding: 0,
            fontSize: 12,
            color: token.colorTextQuaternary,
            height: 'auto',
          }}
        >
          Don't show again
        </Button>
      </div>
    </div>
  );
};
