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
              ? 'To choose or confirm a writable destination, select Skip for now on this Teammate step and finish onboarding, even if your copy is already registered. Then open Create → Teammate and explicitly select your copy in Framework Repository. Use Create → Repository first only if your copy is not registered. Registration alone does not guarantee onboarding selects it.'
              : 'If your copy is not registered, add it via Create → Repository. Then explicitly select your copy below. Confirm that the credentials used by your teammate can push to it.'}
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
