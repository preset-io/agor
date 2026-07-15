'use client';

import { useState } from 'react';
import styles from './GifGallery.module.css';

// "In Action" carousel on the guide index — same interaction grammar as the
// landing-page carousels: arrows, dots, and clicking the media advances.
const gifs = [
  {
    src: '/Area.gif',
    alt: 'Spatial 2D Canvas',
    caption: 'Spatial canvas with branches and zones',
  },
  {
    src: '/Convo.gif',
    alt: 'AI Conversation in Action',
    caption: 'Rich web UI for AI conversations',
  },
  {
    src: '/Settings.gif',
    alt: 'Settings and Configuration',
    caption: 'MCP servers and branch management',
  },
  {
    src: '/Social.gif',
    alt: 'Real-time Multiplayer',
    caption: 'Live collaboration with cursors and comments',
  },
];

export function GifGallery() {
  const [active, setActive] = useState(0);

  return (
    <div className={styles.carousel}>
      <div className={styles.viewport}>
        <div
          className={styles.track}
          style={{
            width: `${gifs.length * 100}%`,
            transform: `translateX(-${(active * 100) / gifs.length}%)`,
          }}
        >
          {gifs.map((gif, index) => (
            <button
              key={gif.src}
              type="button"
              className={styles.slide}
              style={{ width: `${100 / gifs.length}%` }}
              aria-label="Next screenshot"
              onClick={() => setActive((active + 1) % gifs.length)}
            >
              {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
              <img src={gif.src} alt={gif.alt} loading={index === 0 ? 'eager' : 'lazy'} />
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Previous screenshot"
          className={`${styles.arrow} ${styles.arrowLeft}`}
          onClick={() => setActive((active + gifs.length - 1) % gifs.length)}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="Next screenshot"
          className={`${styles.arrow} ${styles.arrowRight}`}
          onClick={() => setActive((active + 1) % gifs.length)}
        >
          ›
        </button>
      </div>
      <p className={styles.caption} aria-live="polite">
        {gifs[active].caption}
      </p>
      <div className={styles.dots}>
        {gifs.map((gif, index) => (
          <button
            key={gif.src}
            type="button"
            aria-label={`Screenshot ${index + 1}: ${gif.caption}`}
            aria-pressed={index === active}
            className={index === active ? `${styles.dot} ${styles.dotActive}` : styles.dot}
            onClick={() => setActive(index)}
          />
        ))}
      </div>
    </div>
  );
}
