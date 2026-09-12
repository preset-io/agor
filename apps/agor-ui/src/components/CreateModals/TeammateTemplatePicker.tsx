import { Flex, Tag, Tooltip, Typography, theme } from 'antd';
import { ONBOARDING_INTEGRATION_RECOMMENDATIONS } from '../../utils/onboardingGoals';
import {
  integrationRecIdsForTemplate,
  type TeammateGalleryCardId,
} from '../../utils/teammateTemplates';
import { TeammateGallery } from '../TeammateGallery';

const { Text, Link } = Typography;

/**
 * Suggested MCP integrations for the picked template, rendered as subtle chips.
 * Wiring the catalog connect drawer/OAuth is out of scope for this pass, so the
 * "Connect" affordance is a no-op placeholder.
 * TODO(create-modals): open the MCP marketplace/connect drawer for `rec`.
 */
const IntegrationKitChips: React.FC<{ templateId: TeammateGalleryCardId | null }> = ({
  templateId,
}) => {
  const { token } = theme.useToken();
  const recs = integrationRecIdsForTemplate(templateId)
    .map((id) => ONBOARDING_INTEGRATION_RECOMMENDATIONS[id])
    .filter(Boolean);

  if (recs.length === 0) return null;

  return (
    <Flex vertical gap={token.marginXXS}>
      <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        Suggested integrations
      </Text>
      <Flex wrap gap={token.marginXXS}>
        {recs.map((rec) => (
          <Tag key={rec.id} style={{ marginInlineEnd: 0, paddingBlock: 2 }}>
            <Tooltip title={rec.description}>
              <span>
                {rec.emoji} {rec.name}
              </span>
            </Tooltip>{' '}
            <Link
              style={{ fontSize: token.fontSizeSM }}
              onClick={(e) => {
                e.stopPropagation();
                // No-op for now — connect wiring deferred (see TODO above).
              }}
            >
              Connect
            </Link>
          </Tag>
        ))}
      </Flex>
    </Flex>
  );
};

export interface TeammateTemplatePickerProps {
  value: TeammateGalleryCardId | null;
  onChange: (templateId: TeammateGalleryCardId | null) => void;
}

/**
 * "Start from a template" region at the top of the create-teammate modal.
 * Reuses the shared TeammateGallery (persona templates + blank starter) and
 * surfaces each template's suggested MCP integration kit. Selecting a card
 * prefills the form fields below via the host's `onChange`.
 */
export const TeammateTemplatePicker: React.FC<TeammateTemplatePickerProps> = ({
  value,
  onChange,
}) => {
  const { token } = theme.useToken();

  return (
    <Flex vertical gap={token.marginSM} style={{ marginBottom: token.margin }}>
      <Text strong>Start from a template</Text>
      {/* Cap the gallery height so the editable fields below stay in view. */}
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        <TeammateGallery value={value} onChange={onChange} />
      </div>
      <IntegrationKitChips templateId={value} />
    </Flex>
  );
};
