'use client';

import { trackEvent } from '../lib/analytics';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, LINKEDIN_URL, X_URL } from '../lib/links';
import { DiscordIcon, GitHubIcon, LinkedInIcon, XIcon } from './BrandIcons';
import styles from './SocialLinks.module.css';

const SOCIALS = [
  { label: 'GitHub', href: GITHUB_REPO_URL, Icon: GitHubIcon },
  { label: 'Discord', href: DISCORD_INVITE_URL, Icon: DiscordIcon },
  { label: 'X', href: X_URL, Icon: XIcon },
  { label: 'LinkedIn', href: LINKEDIN_URL, Icon: LinkedInIcon },
];

/** Row of social icon links (GitHub, Discord, X, LinkedIn). */
export function SocialLinks({ placement }: { placement: string }) {
  return (
    <ul className={styles.socials}>
      {SOCIALS.map((social) => (
        <li key={social.label}>
          <a
            href={social.href}
            target="_blank"
            rel="noopener noreferrer"
            title={social.label}
            onClick={() => trackEvent('nav_click', { target: social.href, placement })}
          >
            <social.Icon aria-hidden="true" />
            <span className={styles.srOnly}>Agor on {social.label}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
