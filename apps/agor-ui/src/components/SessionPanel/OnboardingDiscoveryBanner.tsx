import { CompassOutlined } from '@ant-design/icons';
import { Alert } from 'antd';
import type React from 'react';

export interface OnboardingDiscoveryBannerProps {
  onDismiss: () => void;
}

/**
 * One-time discovery banner for a user's first session ever - points at the
 * "Setup guide" toolbar button (see SessionPanel.tsx) since a brand-new,
 * non-technical user has no way to otherwise know that affordance exists.
 * Separate concern from onboarding flow progress itself: dismissing this
 * banner does not touch the onboarding Knowledge document, and starting or
 * dismissing the onboarding flow does not touch this banner's own state.
 */
export const OnboardingDiscoveryBanner: React.FC<OnboardingDiscoveryBannerProps> = ({
  onDismiss,
}) => (
  <Alert
    type="info"
    showIcon
    icon={<CompassOutlined />}
    closable
    onClose={onDismiss}
    title="New here? Use the Setup guide (compass icon above) anytime to get set up."
    style={{ marginBottom: 12 }}
  />
);
