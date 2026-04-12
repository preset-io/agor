/**
 * InputRequestBlock - Displays an interactive question from the agent (AskUserQuestion tool)
 *
 * Shows:
 * - Question text with header
 * - Radio/checkbox options depending on multiSelect
 * - "Other" free-text input option
 * - Visual states: active (pending), answered, timed out
 */

import type { InputRequestContent, Message } from '@agor-live/client';
import { InputRequestStatus } from '@agor-live/client';
import {
  CheckOutlined,
  ClockCircleOutlined,
  QuestionCircleOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { Button, Card, Checkbox, Input, Radio, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';

const { Title, Text } = Typography;

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
  const { questions, status, answers: savedAnswers, answered_at } = content;

  // Track answers per question (keyed by question text)
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Track "Other" text per question
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  // Track which questions have "Other" selected
  const [otherSelected, setOtherSelected] = useState<Record<string, boolean>>({});
  // Track annotations per question
  const [annotations] = useState<Record<string, { markdown?: string; notes?: string }>>({});

  const isAnswered = status === InputRequestStatus.ANSWERED;
  const isTimedOut = status === InputRequestStatus.TIMED_OUT;

  const getStateStyle = () => {
    if (isTimedOut) {
      return {
        background: 'rgba(250, 173, 20, 0.06)',
        border: `1px solid ${token.colorWarningBorder}`,
      };
    }
    if (isActive) {
      return {
        background: 'rgba(22, 119, 255, 0.04)',
        border: `1px solid ${token.colorPrimaryBorder}`,
      };
    }
    if (isAnswered) {
      return {
        background: 'rgba(82, 196, 26, 0.03)',
        border: `1px solid ${token.colorSuccessBorder}`,
      };
    }
    return {};
  };

  const getIcon = () => {
    if (isTimedOut)
      return <ClockCircleOutlined style={{ fontSize: 20, color: token.colorWarning }} />;
    if (isActive)
      return <QuestionCircleOutlined style={{ fontSize: 20, color: token.colorPrimary }} />;
    if (isAnswered) return <CheckOutlined style={{ fontSize: 20, color: token.colorSuccess }} />;
    return null;
  };

  const getTitle = () => {
    if (isTimedOut) return 'Question Timed Out';
    if (isActive) return 'Agent Question';
    if (isAnswered) return 'Question Answered';
    return 'Agent Question';
  };

  const getSubtitle = () => {
    if (isTimedOut) return 'Prompt the agent to retry';
    if (isActive) return 'The agent needs your input to continue';
    if (isAnswered && answered_at) {
      return `Answered ${new Date(answered_at).toLocaleString()}`;
    }
    return '';
  };

  // Check if all questions have answers
  const allAnswered = questions.every((q) => {
    const key = q.question;
    if (otherSelected[key]) {
      return (otherText[key] || '').trim().length > 0;
    }
    return (answers[key] || '').length > 0;
  });

  const handleSubmit = () => {
    if (!onSubmit || !allAnswered) return;

    // Build final answers: use "Other" text where selected
    const finalAnswers: Record<string, string> = {};
    for (const q of questions) {
      const key = q.question;
      if (otherSelected[key]) {
        finalAnswers[key] = otherText[key] || '';
      } else {
        finalAnswers[key] = answers[key] || '';
      }
    }

    onSubmit(
      message.message_id,
      finalAnswers,
      Object.keys(annotations).length > 0 ? annotations : undefined
    );
  };

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
              <Text type="secondary" style={{ fontSize: 12 }}>
                {getSubtitle()}
              </Text>
            )}
          </div>
        </Space>

        {/* Questions */}
        {questions.map((q, qIdx) => {
          const key = q.question;
          const displayAnswer = isAnswered && savedAnswers ? savedAnswers[key] : undefined;

          return (
            <div
              key={`q-${qIdx}-${q.header}`}
              style={{
                padding: `${token.sizeUnit}px ${token.sizeUnit * 1.5}px`,
                borderRadius: token.borderRadius,
                backgroundColor: token.colorBgLayout,
              }}
            >
              {/* Question header chip */}
              {q.header && (
                <Text
                  strong
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    color: token.colorPrimary,
                    letterSpacing: 0.5,
                  }}
                >
                  {q.header}
                </Text>
              )}

              {/* Question text */}
              <div style={{ marginTop: token.sizeUnit / 2, marginBottom: token.sizeUnit }}>
                <Text>{q.question}</Text>
              </div>

              {/* Options - show answer for resolved, interactive for active */}
              {isAnswered && displayAnswer !== undefined ? (
                <div
                  style={{
                    padding: `${token.sizeUnit}px`,
                    borderRadius: token.borderRadius,
                    backgroundColor: 'rgba(82, 196, 26, 0.06)',
                  }}
                >
                  <Text strong style={{ color: token.colorSuccess }}>
                    {displayAnswer}
                  </Text>
                </div>
              ) : isActive ? (
                <div>
                  {q.multiSelect ? (
                    // Multi-select: checkboxes
                    <Checkbox.Group
                      value={(answers[key] || '').split(', ').filter(Boolean)}
                      onChange={(values) => {
                        setAnswers((prev) => ({
                          ...prev,
                          [key]: (values as string[]).join(', '),
                        }));
                        if (values.length > 0) {
                          setOtherSelected((prev) => ({ ...prev, [key]: false }));
                        }
                      }}
                      style={{ width: '100%' }}
                    >
                      <Space
                        direction="vertical"
                        size={token.sizeUnit / 2}
                        style={{ width: '100%' }}
                      >
                        {q.options.map((opt, oIdx) => (
                          <Checkbox
                            key={`opt-${oIdx}-${opt.label}`}
                            value={opt.label}
                            disabled={otherSelected[key]}
                          >
                            <div>
                              <Text>{opt.label}</Text>
                              {opt.description && (
                                <div>
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {opt.description}
                                  </Text>
                                </div>
                              )}
                            </div>
                          </Checkbox>
                        ))}
                        {/* Other option */}
                        <Checkbox
                          checked={otherSelected[key] || false}
                          onChange={(e) => {
                            setOtherSelected((prev) => ({
                              ...prev,
                              [key]: e.target.checked,
                            }));
                            if (e.target.checked) {
                              setAnswers((prev) => ({ ...prev, [key]: '' }));
                            }
                          }}
                        >
                          Other
                        </Checkbox>
                        {otherSelected[key] && (
                          <Input.TextArea
                            placeholder="Type your answer..."
                            value={otherText[key] || ''}
                            onChange={(e) =>
                              setOtherText((prev) => ({
                                ...prev,
                                [key]: e.target.value,
                              }))
                            }
                            autoSize={{ minRows: 1, maxRows: 4 }}
                            style={{ marginLeft: 24 }}
                          />
                        )}
                      </Space>
                    </Checkbox.Group>
                  ) : (
                    // Single-select: radio buttons
                    <Radio.Group
                      value={otherSelected[key] ? '__other__' : answers[key]}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === '__other__') {
                          setOtherSelected((prev) => ({ ...prev, [key]: true }));
                          setAnswers((prev) => ({ ...prev, [key]: '' }));
                        } else {
                          setOtherSelected((prev) => ({ ...prev, [key]: false }));
                          setAnswers((prev) => ({ ...prev, [key]: val }));
                        }
                      }}
                      style={{ width: '100%' }}
                    >
                      <Space
                        direction="vertical"
                        size={token.sizeUnit / 2}
                        style={{ width: '100%' }}
                      >
                        {q.options.map((opt, oIdx) => (
                          <Radio key={`opt-${oIdx}-${opt.label}`} value={opt.label}>
                            <div>
                              <Text>{opt.label}</Text>
                              {opt.description && (
                                <div>
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {opt.description}
                                  </Text>
                                </div>
                              )}
                            </div>
                          </Radio>
                        ))}
                        {/* Other option */}
                        <Radio value="__other__">Other</Radio>
                        {otherSelected[key] && (
                          <Input.TextArea
                            placeholder="Type your answer..."
                            value={otherText[key] || ''}
                            onChange={(e) =>
                              setOtherText((prev) => ({
                                ...prev,
                                [key]: e.target.value,
                              }))
                            }
                            autoSize={{ minRows: 1, maxRows: 4 }}
                            style={{ marginLeft: 24 }}
                          />
                        )}
                      </Space>
                    </Radio.Group>
                  )}
                </div>
              ) : isTimedOut ? (
                <Text type="secondary" italic>
                  No response received before timeout
                </Text>
              ) : null}
            </div>
          );
        })}

        {/* Timestamp */}
        {isActive && message.timestamp && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            Asked at {new Date(message.timestamp).toLocaleString()}
          </Text>
        )}

        {/* Submit button - only when active */}
        {isActive && onSubmit && (
          <Button
            type="primary"
            icon={<SendOutlined />}
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
