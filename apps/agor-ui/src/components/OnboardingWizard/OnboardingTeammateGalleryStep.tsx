// biome-ignore-all lint/plugin/noHardcodedColorLiteral: intentional dark-glass onboarding input treatment, matching the owning wizard surface
import { Flex, Input, Typography, theme } from 'antd';
import { type Ref, useState } from 'react';
import type { TeammateGalleryCardId } from '../../utils/teammateTemplates';
import { EmojiPickerInput } from '../EmojiPickerInput/EmojiPickerInput';
import { TeammateGalleryCards } from '../TeammateGallery/TeammateGallery';

const { Paragraph, Text, Title } = Typography;

interface OnboardingTeammateGalleryStepProps {
  /** Signed-in user's first name for the welcome title. */
  firstName?: string;
  /** Local-home disclosure, only for teammates created from the public framework. */
  showPublicStarterNote: boolean;
  selectedTemplateId: TeammateGalleryCardId | null;
  onTemplateChange: (templateId: TeammateGalleryCardId | null) => void;
  teammateName: string;
  onTeammateNameChange: (name: string) => void;
  teammateEmoji: string;
  onTeammateEmojiChange: (emoji: string) => void;
  headingRef: Ref<HTMLHeadingElement>;
}

/**
 * Onboarding-specific chrome and scroll behavior around the reusable gallery.
 * Keeping the wizard heading/name/focus concerns here prevents the gallery's
 * selection API from accumulating host-specific ReactNode slots.
 */
export const OnboardingTeammateGalleryStep: React.FC<OnboardingTeammateGalleryStepProps> = ({
  firstName,
  showPublicStarterNote,
  selectedTemplateId,
  onTemplateChange,
  teammateName,
  onTeammateNameChange,
  teammateEmoji,
  onTeammateEmojiChange,
  headingRef,
}) => {
  const { token } = theme.useToken();
  const [scrolled, setScrolled] = useState(false);

  return (
    <Flex vertical style={{ flex: '1 1 auto', minHeight: 0 }}>
      <div style={{ flex: '0 0 auto', paddingBottom: token.paddingSM }}>
        <div
          className="onb-workspace-collapsible"
          data-collapsible-header=""
          style={{
            overflow: 'hidden',
            maxHeight: scrolled ? 0 : 240,
            opacity: scrolled ? 0 : 1,
            marginBottom: scrolled ? 0 : token.marginSM,
            transition: 'max-height 0.25s ease, opacity 0.2s ease, margin-bottom 0.25s ease',
          }}
        >
          <Title
            ref={headingRef}
            data-step="workspace"
            level={3}
            tabIndex={-1}
            style={{ color: token.colorText, margin: 0, outline: 'none' }}
          >
            Hi {firstName || 'there'}, meet your teammate
          </Title>
          <Paragraph style={{ color: token.colorTextSecondary, margin: `${token.marginXS}px 0 0` }}>
            Your teammate is your AI helper. They work with you and your team, and remember how you
            like things done.
          </Paragraph>
        </div>

        <div>
          <Text
            style={{
              color: token.colorTextSecondary,
              display: 'block',
              marginBottom: token.marginXXS,
            }}
          >
            Teammate name
          </Text>
          <Flex>
            <EmojiPickerInput
              value={teammateEmoji}
              onChange={onTeammateEmojiChange}
              defaultEmoji="🤖"
            />
            <Input
              aria-label="Teammate name"
              placeholder="e.g. Rusty, Ada, Scout…"
              value={teammateName}
              onChange={(event) => onTeammateNameChange(event.target.value)}
              style={{
                background: 'rgba(0,0,0,0.3)',
                borderColor: 'rgba(255,255,255,0.12)',
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                flex: 1,
              }}
            />
          </Flex>
          <Text
            className="onb-workspace-helper"
            style={{
              color: token.colorTextTertiary,
              fontSize: token.fontSizeSM,
              display: 'block',
              marginTop: token.marginXXS,
            }}
          >
            They'll get their own board when you finish.
          </Text>
        </div>
      </div>

      <div
        onScroll={(event) => {
          const next = event.currentTarget.scrollTop > 8;
          setScrolled((previous) => (previous === next ? previous : next));
        }}
        style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}
      >
        <Text strong style={{ display: 'block' }}>
          Pick a starting point
        </Text>
        <Paragraph style={{ color: token.colorTextSecondary, marginBottom: token.marginXS }}>
          Start with Team assistant and shape them as you chat, or pick a template for a head start.
        </Paragraph>
        <TeammateGalleryCards value={selectedTemplateId} onChange={onTemplateChange} compact />
        {showPublicStarterNote && (
          <Text type="secondary">
            With the public starter, home files stay on this installation without private backup.
            Memory lives in Knowledge.
          </Text>
        )}
      </div>
    </Flex>
  );
};
