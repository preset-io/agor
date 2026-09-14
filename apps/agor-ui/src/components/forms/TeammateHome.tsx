import {
  type AgorClient,
  extractSlugFromUrl,
  normalizeRepoUrl,
  type Repo,
  type UpdateUserInput,
  type User,
} from '@agor-live/client';
import { Alert, Button, Checkbox, Collapse, Flex, Input, Select, Typography, theme } from 'antd';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '@/hooks/useAuthorityOperationGuard';
import { destinationProblem, validateDestinationUrl } from '@/utils/teammateDestination';

interface Props {
  client: AgorClient | null;
  user?: User | null;
  repoId?: string;
  onChange: (repoId: string | undefined) => void | Promise<void>;
  onReadyChange: (ready: boolean) => void;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  beforeLeave?: () => Promise<unknown>;
  disabled?: boolean;
}

/** Shared inline home selector. Registration uses the existing caller-scoped clone service. */
export function TeammateHome({
  client,
  user,
  repoId,
  onChange,
  onReadyChange,
  acknowledged,
  onAcknowledgedChange,
  beforeLeave,
  disabled,
}: Props) {
  const { token } = theme.useToken();
  const authority = useAuthenticatedAuthorityScope(
    client,
    user ? `${user.user_id}:${user.role}` : null
  );
  const guard = useAuthorityOperationGuard(authority.operationScope);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selected, setSelected] = useState<Repo>();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<object | null>(null);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [githubToken, setGithubToken] = useState('');
  const [credentialStatus, setCredentialStatus] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: caller-private input must not survive identity replacement
  useLayoutEffect(() => {
    inFlight.current = null;
    setBusy(false);
    setGithubToken('');
    setUrl('');
    setError(undefined);
    setCredentialStatus('');
    setRepos([]);
    setSelected(undefined);
    onAcknowledgedChange(false);
  }, [authority.identityKey]);
  const saveGitCredential = async () => {
    const operation = guard.begin();
    if (!client || !user || !operation.isCurrent() || !githubToken.trim() || inFlight.current)
      return;
    const attempt = {};
    inFlight.current = attempt;
    setBusy(true);
    setError(undefined);
    const value = githubToken.trim();
    setGithubToken('');
    try {
      // Same encrypted, write-only user credential patch as UserSettingsModal.
      // This is executor Git access, not an MCP credential or a push-access verdict.
      const updates: UpdateUserInput = {
        env_vars: { GITHUB_TOKEN: value },
        env_var_scopes: { GITHUB_TOKEN: 'global' },
      };
      await client.service('users').patch(user.user_id, updates as Partial<User>);
      if (!operation.isCurrent()) return;
      setCredentialStatus(
        'Repository credential saved. Retry cloning; push access is still unchecked.'
      );
    } catch {
      if (operation.isCurrent())
        setError('Could not save repository credentials. Reconnect and try again.');
    } finally {
      if (inFlight.current === attempt) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the caller-scoped inventory
  useEffect(() => {
    const operation = guard.begin();
    setLoaded(false);
    setSelected(undefined);
    onReadyChange(false);
    if (!client || !operation.isCurrent()) return;
    let sequence = 0;
    const read = async () => {
      const request = ++sequence;
      try {
        const result = await client.service('repos').find({ query: { $limit: 1000 } });
        if (!operation.isCurrent() || request !== sequence) return;
        const exact = repoId ? await client.service('repos').get(repoId) : undefined;
        if (!operation.isCurrent() || request !== sequence) return;
        setRepos(Array.isArray(result) ? result : result.data);
        setSelected(exact?.repo_id === repoId ? exact : undefined);
        setLoaded(true);
        onReadyChange(!!exact && exact.repo_id === repoId && !destinationProblem(exact));
      } catch {
        if (!operation.isCurrent() || request !== sequence) return;
        setError('Could not load this destination. Reconnect or choose another repository.');
        setSelected(undefined);
        onReadyChange(false);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 3000);
    return () => {
      operation.cancel();
      clearInterval(timer);
    };
  }, [client, guard, repoId, refresh, onReadyChange]);

  const register = async (retry?: Repo) => {
    if (inFlight.current || !client || disabled) return;
    const operation = guard.begin();
    if (!operation.isCurrent()) return;
    const attempt = {};
    inFlight.current = attempt;
    setBusy(true);
    setError(undefined);
    try {
      const remote = validateDestinationUrl(retry?.remote_url ?? url);
      // Discover before mutation, including recovery after an ambiguous lost response.
      const result = await client.service('repos').find({ query: { $limit: 1000 } });
      if (!operation.isCurrent()) return;
      const available = Array.isArray(result) ? result : result.data;
      const existing = available.find(
        (repo) => repo.remote_url && normalizeRepoUrl(repo.remote_url) === normalizeRepoUrl(remote)
      );
      const slug = retry?.slug ?? extractSlugFromUrl(remote);
      if (
        available.some(
          (repo) =>
            repo.slug === slug &&
            repo.remote_url &&
            normalizeRepoUrl(repo.remote_url) !== normalizeRepoUrl(remote)
        )
      ) {
        throw new Error(
          'That repository name is already registered with another URL. Select the correct repository.'
        );
      }
      const response =
        existing && existing.clone_status !== 'failed'
          ? { repo_id: existing.repo_id }
          : await client
              .service('repos/clone')
              .create({ url: remote, ...(retry ? { slug: retry.slug } : {}) });
      if (!operation.isCurrent()) return;
      if (!response.repo_id) throw new Error('Registration did not return a destination ID.');
      const exact = await client.service('repos').get(response.repo_id);
      if (!operation.isCurrent()) return;
      if (!exact.remote_url || normalizeRepoUrl(exact.remote_url) !== normalizeRepoUrl(remote)) {
        throw new Error(
          'That repository name is already registered with another URL. Select the correct repository.'
        );
      }
      onAcknowledgedChange(false);
      await onChange(exact.repo_id);
      if (!operation.isCurrent()) return;
      setRefresh((value) => value + 1);
    } catch (err) {
      if (operation.isCurrent())
        setError(
          err instanceof Error && /^(Paste|Add your|That repository)/.test(err.message)
            ? err.message
            : 'Could not register this repository. Check the URL, your access, and connection, then retry.'
        );
    } finally {
      if (inFlight.current === attempt) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  };
  const problem = destinationProblem(selected);

  return (
    <Flex vertical gap={token.marginSM}>
      <Typography.Text>
        Choose a repository for memory and work. We’ll bring your selected starter.
      </Typography.Text>
      <Select
        aria-label="Teammate home repository"
        placeholder="Choose a repository"
        value={repoId}
        disabled={disabled || busy}
        loading={!loaded}
        showSearch
        optionFilterProp="label"
        options={repos
          .filter((repo) => !!repo.remote_url)
          .map((repo) => ({ value: repo.repo_id, label: repo.name || repo.slug }))}
        onChange={(id) => {
          setError(undefined);
          onAcknowledgedChange(false);
          void onChange(id);
        }}
      />
      <div role="status" aria-live="polite">
        {repoId && (problem ?? 'Clone ready · Push access unchecked · Visibility unknown')}
      </div>
      {selected && !problem && (
        <Checkbox
          checked={acknowledged}
          disabled={disabled}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
        >
          I have permission to store work here and have checked who can see it. Agor has not
          verified push access and does not automatically back it up.
        </Checkbox>
      )}
      {error && <Alert type="error" title={error} role="alert" />}
      {selected?.clone_status === 'failed' && (
        <Button disabled={disabled} loading={busy} onClick={() => void register(selected)}>
          Retry cloning this repository
        </Button>
      )}
      <Button
        size="small"
        onClick={() => {
          setError(undefined);
          setRefresh((value) => value + 1);
        }}
      >
        Refresh repositories
      </Button>
      <Collapse
        size="small"
        onChange={() => setGithubToken('')}
        items={[
          {
            key: 'github-auth',
            label: 'GitHub repository sign-in',
            children: (
              <Flex vertical gap={token.marginSM}>
                <Typography.Text type="secondary">
                  Save your GitHub token in Agor’s encrypted user credentials for Git operations.
                  Use a token limited to your destination with Contents read/write access. This is
                  separate from GitHub MCP.
                </Typography.Text>
                <Input.Password
                  aria-label="GitHub repository token"
                  autoComplete="new-password"
                  value={githubToken}
                  onChange={(event) => setGithubToken(event.target.value)}
                  disabled={busy || disabled}
                />
                <Button
                  disabled={!githubToken.trim() || disabled}
                  loading={busy}
                  onClick={() => void saveGitCredential()}
                >
                  Save repository credential
                </Button>
                <div role="status">{credentialStatus}</div>
              </Flex>
            ),
          },
          {
            key: 'add',
            label: 'Add a repository',
            children: (
              <Flex vertical gap={token.marginSM}>
                <Input
                  aria-label="Repository URL"
                  placeholder="https://github.com/your-team/teammate-memory"
                  value={url}
                  disabled={busy || disabled}
                  onChange={(event) => setUrl(event.target.value)}
                />
                <Button
                  onClick={() => void register()}
                  loading={busy}
                  disabled={!url.trim() || disabled}
                >
                  Register repository
                </Button>
                <Typography.Text type="secondary">
                  No repository yet? Create one with a README, then paste its URL here. Confirm
                  private visibility on GitHub.
                </Typography.Text>
                <Typography.Link
                  href="https://github.com/new?name=teammate-memory&visibility=private"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    if (beforeLeave) {
                      event.preventDefault();
                      const operation = guard.begin();
                      const tab = window.open('about:blank', '_blank');
                      if (tab) tab.opener = null;
                      void beforeLeave()
                        .then(() => {
                          if (tab && operation.isCurrent())
                            tab.location.href =
                              'https://github.com/new?name=teammate-memory&visibility=private';
                          else tab?.close();
                        })
                        .catch(() => {
                          tab?.close();
                          if (operation.isCurrent())
                            setError('Could not save your draft. Retry before opening GitHub.');
                        });
                    }
                  }}
                >
                  Create a private repository on GitHub ↗
                </Typography.Link>
              </Flex>
            ),
          },
        ]}
      />
    </Flex>
  );
}
