import { TEAMMATE_FRAMEWORK_REPO_SLUG, TEAMMATE_FRAMEWORK_REPO_URL } from '@agor-live/client';
import { Alert, Typography, theme } from 'antd';

/** Guidance, not a permission check: repo metadata cannot prove upstream write access. */
export function TeammateRepositoryGuidance({ onboarding = false }: { onboarding?: boolean }) {
  const { token } = theme.useToken();

  return (
    <Alert
      type="info"
      showIcon={!onboarding}
      style={{ marginBottom: token.marginMD, ...(onboarding ? { padding: token.paddingSM } : {}) }}
      title="Choose a repository you can push to"
      description={
        <>
          <div>
            Fork or copy{' '}
            <Typography.Link
              href={TEAMMATE_FRAMEWORK_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {TEAMMATE_FRAMEWORK_REPO_SLUG}
            </Typography.Link>{' '}
            into your own account or organization; prefer a private copy for memory. Cloning the
            public template does not grant push access.
          </div>
          <div style={{ marginTop: token.marginXS }}>
            {onboarding
              ? 'Need your own copy? Skip this Teammate step, then use Create → Repository and Create → Teammate.'
              : 'Add your copy via Create → Repository, then select it below. Confirm that the credentials used by your teammate can push to it.'}
          </div>
          {!onboarding && (
            <div style={{ marginTop: token.marginXS }}>
              A public fork or a branch named private-* does not make memory private. Local/offline
              use can continue without push access, but changes stay local until backed up or pushed
              to a writable remote.
            </div>
          )}
        </>
      }
    />
  );
}
