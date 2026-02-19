/**
 * InputRequestBlock - Displays an AskUserQuestion input request
 *
 * Shows:
 * - Questions with selectable options (radio for single, checkbox for multi)
 * - "Other" free-text input for each question
 * - Submit button to send all answers
 * - Answered/timed-out states for resolved requests
 */

import { type InputRequestContent, InputRequestStatus, type Message } from '@agor/core/types';
import { CheckOutlined, ClockCircleOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import { Button, Card, Checkbox, Input, Radio, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';

const { Title } = Typography;

interface InputRequestBlockProps {
  message: Message;
  content: InputRequestContent;
  isActive: boolean;
  onSubmit?: (
    messageId: string,
    answers: Record<string, string>,
    annotations?: Record<string, { markdown?: string; notes?: string }>
  ) => void;
}

export const InputRequestBlock: React.FC<InputRequestBlockProps> = ({
  message,
  content,
  isActive,
  onSubmit,
}) => {
  const { token } = theme.useToken();
  const { questions, status, answers: existingAnswers, answered_at, answered_by } = content;

  // Track selected answers per question (keyed by question text)
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [usingOther, setUsingOther] = useState<Record<string, boolean>>({});

  const isAnswered = status === InputRequestStatus.ANSWERED;
  const isTimedOut = status === InputRequestStatus.TIMED_OUT;

  const getStateStyle = () => {
    if (isActive) {
      return {
        background: 'rgba(22, 119, 255, 0.05)',
        border: `1px solid ${token.colorPrimaryBorder}`,
      };
    }
    if (isAnswered) {
      return {
        background: 'rgba(82, 196, 26, 0.03)',
        border: `1px solid ${token.colorSuccessBorder}`,
      };
    }
    if (isTimedOut) {
      return {
        background: 'rgba(0, 0, 0, 0.02)',
        border: `1px solid ${token.colorBorder}`,
        opacity: 0.7,
      };
    }
    return {};
  };

  const getIcon = () => {
    if (isActive)
      return <QuestionCircleOutlined style={{ fontSize: 20, color: token.colorPrimary }} />;
    if (isAnswered) return <CheckOutlined style={{ fontSize: 20, color: token.colorSuccess }} />;
    if (isTimedOut)
      return <ClockCircleOutlined style={{ fontSize: 20, color: token.colorTextDisabled }} />;
    return null;
  };

  const getTitle = () => {
    if (isActive) return 'Question from Agent';
    if (isAnswered) return 'Question Answered';
    if (isTimedOut) return 'Question Timed Out';
    return 'Question';
  };

  const getSubtitle = () => {
    if (isActive) return 'The agent needs your input to continue';
    if (isAnswered && answered_at) {
      const byText = answered_by ? ` by ${answered_by}` : '';
      return `Answered${byText} ${new Date(answered_at).toLocaleString()}`;
    }
    if (isTimedOut) return 'This question timed out before receiving an answer';
    return '';
  };

  const handleSubmit = () => {
    if (!onSubmit) return;

    const answers: Record<string, string> = {};
    for (const q of questions) {
      if (usingOther[q.question]) {
        answers[q.question] = otherText[q.question] || '';
      } else {
        answers[q.question] = selectedAnswers[q.question] || '';
      }
    }

    onSubmit(message.message_id, answers);
  };

  // Check if all questions have answers
  const allAnswered = questions.every((q) => {
    if (usingOther[q.question]) return (otherText[q.question] || '').trim().length > 0;
    return (selectedAnswers[q.question] || '').length > 0;
  });

  return (
    <Card
      style={{
        marginTop: token.sizeUnit * 2,
        ...getStateStyle(),
      }}
      styles={{
        body: {
          padding: token.sizeUnit * 2,
        },
      }}
    >
      <Space direction="vertical" size={token.sizeUnit * 1.5} style={{ width: '100%' }}>
        {/* Header */}
        <Space size={token.sizeUnit}>
          {getIcon()}
          <div>
            <Title level={5} style={{ margin: 0 }}>
              {getTitle()}
            </Title>
            {getSubtitle() && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {getSubtitle()}
              </Typography.Text>
            )}
          </div>
        </Space>

        {/* Questions */}
        {questions.map((q, qIdx) => (
          <div
            key={`q-${qIdx}-${q.question.substring(0, 20)}`}
            style={{
              padding: token.sizeUnit,
              background: token.colorBgContainer,
              borderRadius: token.borderRadius,
            }}
          >
            {q.header && (
              <Typography.Text
                strong
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  color: token.colorTextSecondary,
                }}
              >
                {q.header}
              </Typography.Text>
            )}
            <Typography.Paragraph style={{ margin: `${token.sizeUnit / 2}px 0` }}>
              {q.question}
            </Typography.Paragraph>

            {/* Active: show interactive options */}
            {isActive && !q.multiSelect && (
              <Radio.Group
                value={usingOther[q.question] ? '__other__' : selectedAnswers[q.question]}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__other__') {
                    setUsingOther((prev) => ({ ...prev, [q.question]: true }));
                  } else {
                    setUsingOther((prev) => ({ ...prev, [q.question]: false }));
                    setSelectedAnswers((prev) => ({ ...prev, [q.question]: val }));
                  }
                }}
                style={{ width: '100%' }}
              >
                <Space direction="vertical" size={token.sizeUnit / 2} style={{ width: '100%' }}>
                  {q.options.map((opt) => (
                    <Radio key={opt.label} value={opt.label}>
                      <span>
                        <strong>{opt.label}</strong>
                        {opt.description && (
                          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                            — {opt.description}
                          </Typography.Text>
                        )}
                      </span>
                    </Radio>
                  ))}
                  <Radio value="__other__">
                    <strong>Other</strong>
                  </Radio>
                  {usingOther[q.question] && (
                    <Input.TextArea
                      placeholder="Type your answer..."
                      value={otherText[q.question] || ''}
                      onChange={(e) =>
                        setOtherText((prev) => ({ ...prev, [q.question]: e.target.value }))
                      }
                      autoSize={{ minRows: 1, maxRows: 4 }}
                      style={{ marginLeft: 24 }}
                    />
                  )}
                </Space>
              </Radio.Group>
            )}

            {/* Active: multi-select */}
            {isActive && q.multiSelect && (
              <Checkbox.Group
                value={(() => {
                  try {
                    return JSON.parse(selectedAnswers[q.question] || '[]');
                  } catch {
                    return [];
                  }
                })()}
                onChange={(vals) => {
                  setSelectedAnswers((prev) => ({
                    ...prev,
                    [q.question]: JSON.stringify(vals),
                  }));
                }}
                style={{ width: '100%' }}
              >
                <Space direction="vertical" size={token.sizeUnit / 2} style={{ width: '100%' }}>
                  {q.options.map((opt) => (
                    <Checkbox key={opt.label} value={opt.label}>
                      <span>
                        <strong>{opt.label}</strong>
                        {opt.description && (
                          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                            — {opt.description}
                          </Typography.Text>
                        )}
                      </span>
                    </Checkbox>
                  ))}
                </Space>
              </Checkbox.Group>
            )}

            {/* Answered: show selected answer */}
            {isAnswered && existingAnswers && (
              <Typography.Text code style={{ fontSize: 13 }}>
                {existingAnswers[q.question] || '(no answer)'}
              </Typography.Text>
            )}

            {/* Timed out */}
            {isTimedOut && (
              <Typography.Text type="secondary" italic>
                No answer received
              </Typography.Text>
            )}
          </div>
        ))}

        {/* Timestamp */}
        {isActive && message.timestamp && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Asked at {new Date(message.timestamp).toLocaleString()}
          </Typography.Text>
        )}

        {/* Submit button */}
        {isActive && onSubmit && (
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={handleSubmit}
            disabled={!allAnswered}
          >
            Submit Answer{questions.length > 1 ? 's' : ''}
          </Button>
        )}
      </Space>
    </Card>
  );
};
