import type { Repo } from '@agor-live/client';
import { extractSlugFromUrl } from '@agor-live/client';

export type UrlDisplayRepo = Pick<Repo, 'slug' | 'remote_url'>;

interface UrlDisplayLabelOptions {
  /** Repo for the current branch/worktree. Used to identify same-repo GitHub links. */
  currentRepo?: UrlDisplayRepo;
}

function normalizeRepoSlug(slug?: string): string | undefined {
  const normalized = slug
    ?.trim()
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
  return normalized || undefined;
}

function gitRemoteHost(remoteUrl: string): string | undefined {
  try {
    return new URL(remoteUrl).hostname.toLowerCase();
  } catch {
    // scp-like SSH remotes, e.g. git@github.com:owner/repo.git
    const match = remoteUrl.match(/^[^@]+@([^:]+):/);
    return match?.[1]?.toLowerCase();
  }
}

export function getGitHubRepoSlugFromRemoteUrl(remoteUrl?: string): string | undefined {
  if (!remoteUrl || gitRemoteHost(remoteUrl) !== 'github.com') return undefined;

  try {
    return normalizeRepoSlug(extractSlugFromUrl(remoteUrl));
  } catch {
    return undefined;
  }
}

function getGitHubRepoSlugFromWebUrl(url: URL): string | undefined {
  const pathParts = url.pathname.split('/').filter(Boolean);
  if (url.hostname !== 'github.com' || pathParts.length < 2) return undefined;
  return normalizeRepoSlug(`${pathParts[0]}/${pathParts[1]}`);
}

function getCurrentGitHubRepoSlug(repo?: UrlDisplayRepo): string | undefined {
  // Use the repo's actual GitHub remote identity. Do not fall back to the Agor
  // slug: non-GitHub repos can legitimately share the same owner/repo slug as
  // a GitHub repo, and local repos may use a synthetic `local/<name>` slug.
  return getGitHubRepoSlugFromRemoteUrl(repo?.remote_url);
}

/**
 * Extract a concise display label from a URL.
 * GitHub: org/repo#123 (or #123 when same as currentRepo's GitHub remote),
 * Shortcut: story/12345, Jira/Linear: ticket ID, etc.
 */
export function getUrlDisplayLabel(url: string, options: UrlDisplayLabelOptions = {}): string {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    if (parsed.hostname === 'github.com' && pathParts.length >= 4) {
      const [org, repo, kind, number] = pathParts;
      const urlRepoSlug = `${org}/${repo}`;
      const isIssueOrPr = kind === 'issues' || kind === 'pull';

      if (
        isIssueOrPr &&
        getGitHubRepoSlugFromWebUrl(parsed) === getCurrentGitHubRepoSlug(options.currentRepo)
      ) {
        return `#${number}`;
      }

      return `${urlRepoSlug}#${number}`;
    }

    if (parsed.hostname === 'app.shortcut.com' && pathParts.length >= 3) {
      return `${pathParts[1]}/${pathParts[2]}`;
    }

    if (parsed.hostname.includes('atlassian.net') || parsed.hostname.includes('jira')) {
      return pathParts[pathParts.length - 1] || parsed.hostname;
    }

    if (parsed.hostname === 'linear.app') {
      // Linear URLs: /issue/TEAM-123/slug — extract the issue ID, not the slug
      const issueIdx = pathParts.indexOf('issue');
      if (issueIdx !== -1 && pathParts[issueIdx + 1]) {
        return pathParts[issueIdx + 1];
      }
      return pathParts[pathParts.length - 1] || parsed.hostname;
    }

    return pathParts[pathParts.length - 1] || parsed.hostname;
  } catch {
    return url.split('/').pop() || '?';
  }
}

export function isGitHubUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'github.com' || hostname.endsWith('.github.com');
  } catch {
    return false;
  }
}
