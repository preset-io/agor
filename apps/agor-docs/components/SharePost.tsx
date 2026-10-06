'use client';

import { Check, Link2 } from 'lucide-react';
import { useState } from 'react';
import { trackEvent } from '../lib/analytics';
import { LinkedInIcon, XIcon } from './BrandIcons';
import styles from './SharePost.module.css';

const HASHTAGS = ['MultiplayerAI', 'Agor'];

/**
 * Share row for blog posts: post to X or LinkedIn with the title and link
 * pre-filled, or copy the link. (Following Agor lives in the nav and footer;
 * this is for passing a post along.)
 */
export function SharePost({
  title,
  url,
  placement,
}: {
  title: string;
  /** Absolute canonical URL of the post. */
  url: string;
  placement: 'post-top' | 'post-end';
}) {
  const [copied, setCopied] = useState(false);
  const text = `Reading “${title}”`;

  const xHref = `https://x.com/intent/post?${new URLSearchParams({
    text,
    url,
    via: 'agorcloud',
    hashtags: HASHTAGS.join(','),
  })}`;
  // LinkedIn's share-offsite endpoint takes only a URL; the feed composer
  // accepts pre-filled text, so the link and hashtags ride in the text.
  const linkedInHref = `https://www.linkedin.com/feed/?${new URLSearchParams({
    shareActive: 'true',
    text: `${text} from Agor: ${url} ${HASHTAGS.map((tag) => `#${tag}`).join(' ')}`,
  })}`;

  const track = (network: string) =>
    trackEvent('share_click', { network, placement, page_url: url });

  const copy = () => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      track('copy');
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className={placement === 'post-end' ? `${styles.share} ${styles.end}` : styles.share}>
      <span className={styles.label}>{placement === 'post-end' ? 'Share this post' : 'Share'}</span>
      <a
        href={xHref}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.button}
        onClick={() => track('x')}
      >
        <XIcon size={14} />
        <span className={styles.srOnly}>Share on X</span>
      </a>
      <a
        href={linkedInHref}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.button}
        onClick={() => track('linkedin')}
      >
        <LinkedInIcon size={14} />
        <span className={styles.srOnly}>Share on LinkedIn</span>
      </a>
      <button type="button" className={styles.button} onClick={copy}>
        {copied ? <Check size={15} aria-hidden /> : <Link2 size={15} aria-hidden />}
        <span className={styles.srOnly}>{copied ? 'Link copied' : 'Copy link'}</span>
      </button>
    </div>
  );
}
