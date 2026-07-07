'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import { BRAND_NAME, LOGO_PATH } from '../lib/siteMetadata';
import Aurora from './Aurora/Aurora';
import { GifGallery } from './GifGallery';
import styles from './Hero.module.css';
import { HubSpotFormModal } from './HubSpotFormModal';

interface HeroProps {
  title: string;
  subtitle: string;
  description?: string;
  ctaText?: string;
  ctaLink?: string;
  imageSrc?: string;
  imageAlt?: string;
}

export function Hero({
  title,
  subtitle,
  description,
  ctaText = 'Get Started',
  ctaLink = '/guide',
  imageSrc,
  imageAlt = 'Hero image',
}: HeroProps) {
  const [isContactOpen, setIsContactOpen] = useState(false);
  return (
    <div className={styles.heroWrapper}>
      <div className={styles.auroraBackground}>
        <Aurora colorStops={['#3B82F6', '#06B6D4', '#0408ef']} amplitude={0.9} blend={1} />
      </div>

      <div className={styles.hero}>
        <div className={styles.heroContent}>
          {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
          <img src={LOGO_PATH} alt={`${BRAND_NAME} logo`} className={styles.heroLogo} />
          <h1 className={styles.heroTitle}>{title}</h1>
          <p className={styles.heroSubtitle}>{subtitle}</p>
          {description && <p className={styles.heroDescription}>{description}</p>}

          <div className={styles.heroActions}>
            <Link href={ctaLink} className={styles.primaryButton}>
              {ctaText}
            </Link>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setIsContactOpen(true)}
            >
              Contact us →
            </button>
            <Link
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.secondaryButton}
            >
              View on GitHub →
            </Link>
            <Link
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.secondaryButton}
            >
              Join Discord →
            </Link>
          </div>

          {/* GIF Grid */}
          <div style={{ marginTop: '100px' }}>
            <GifGallery />
          </div>
        </div>

        {imageSrc && (
          <div className={styles.heroImage}>
            {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
            <img src={imageSrc} alt={imageAlt} />
          </div>
        )}
      </div>

      <HubSpotFormModal isOpen={isContactOpen} onClose={() => setIsContactOpen(false)} />
    </div>
  );
}
