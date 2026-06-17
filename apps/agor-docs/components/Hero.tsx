import Link from 'next/link';
import { useState } from 'react';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../lib/links';
import { GifGallery } from './GifGallery';
import styles from './Hero.module.css';
import { HubSpotFormModal } from './HubSpotFormModal';
import { ParticleBackground } from './ParticleBackground';

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
      <ParticleBackground />

      <div className={styles.hero}>
        <div className={styles.heroContent}>
          {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
          <img src="/logo.png" alt="agor logo" className={styles.heroLogo} />
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

      {/* Attribution */}
      <a
        href="https://particles.js.org"
        target="_blank"
        rel="noopener noreferrer"
        className={styles.particlesAttribution}
      >
        🤍 tsparticles
      </a>

      <HubSpotFormModal isOpen={isContactOpen} onClose={() => setIsContactOpen(false)} />
    </div>
  );
}
