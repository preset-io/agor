// biome-ignore-all lint/plugin/noHardcodedColorLiteral: intentional dark-glass onboarding input treatment, matching the owning wizard surface
import { Flex, Input, Typography, theme } from 'antd';
import { type Ref, useState } from 'react';
import type { GalleryFilter, TeammateGalleryCardId } from '../../utils/teammateTemplates';
import { EmojiPickerInput } from '../EmojiPickerInput/EmojiPickerInput';
import { TeammateGalleryCards, TeammateGalleryFilters } from '../TeammateGallery/TeammateGallery';

const { Paragraph, Text, Title } = Typography;

interface OnboardingTeammateGalleryStepProps {
  goals: readonly string[];
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
  goals,
  selectedTemplateId,
  onTemplateChange,
  teammateName,
  onTeammateNameChange,
  teammateEmoji,
  onTeammateEmojiChange,
  headingRef,
}) => {
  const { token } = theme.useToken();
  const [filter, setFilter] = useState<GalleryFilter>('all');
  const [scrolled, setScrolled] = useState(false);

  return (
    <Flex vertical style={{ flex: '1 1 auto', minHeight: 0 }}>
      <div style={{ flex: '0 0 auto', paddingBottom: token.paddingSM }}>
        <div
          data-collapsible-header=""
          style={{
            overflow: 'hidden',
            maxHeight: scrolled ? 0 : 200,
            opacity: scrolled ? 0 : 1,
            marginBottom: scrolled ? 0 : token.marginSM,
            transition: 'max-height 0.25s ease, opacity 0.2s ease, margin-bottom 0.25s ease',
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <Title
              ref={headingRef}
              data-step="workspace"
              level={3}
              tabIndex={-1}
              style={{ color: token.colorText, margin: 0, outline: 'none' }}
            >
              Build your teammate
            </Title>
          </div>
          <Paragraph
            className="onb-workspace-intro-copy"
            style={{ color: token.colorTextSecondary, margin: 0 }}
          >
            Name your teammate and pick a starter template to shape what they do, or start blank.
            Change anything later.
          </Paragraph>
        </div>

        <Flex vertical gap={token.marginSM}>
          <Flex vertical gap={14}>
            <div>
              <Text
                style={{
                  color: token.colorTextSecondary,
                  fontSize: 13,
                  display: 'block',
                  marginBottom: 6,
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
                  fontSize: 12,
                  display: 'block',
                  marginTop: 6,
                }}
              >
                We'll set them up as the primary teammate on a new board when you finish.
              </Text>
            </div>

            <Text style={{ color: token.colorTextSecondary, fontSize: 13, display: 'block' }}>
              Start from a template
            </Text>
          </Flex>
          <TeammateGalleryFilters value={filter} onChange={setFilter} />
        </Flex>
      </div>

      <div
        onScroll={(event) => {
          const next = event.currentTarget.scrollTop > 8;
          setScrolled((previous) => (previous === next ? previous : next));
        }}
        style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}
      >
        <TeammateGalleryCards
          goals={goals}
          value={selectedTemplateId}
          onChange={onTemplateChange}
          filter={filter}
        />
      </div>
    </Flex>
  );
};
