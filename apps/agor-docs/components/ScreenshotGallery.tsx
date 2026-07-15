'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './ScreenshotGallery.module.css';

interface Shot {
  src: string;
  alt: string;
  caption: string;
}

// Flex-wrap thumbnail wall (3-4 per row, grows gracefully as shots are
// added) where each thumbnail opens the full-size image in a lightbox.
export function ScreenshotGallery({ shots }: { shots: Shot[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // Kept mounted through the fade-out: `closing` plays the exit animation,
  // then onAnimationEnd unmounts.
  const [closing, setClosing] = useState(false);

  const close = useCallback(() => setClosing(true), []);

  useEffect(() => {
    if (openIndex === null) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openIndex, close]);

  const open = openIndex === null ? null : shots[openIndex];

  return (
    <>
      <div className={styles.wall}>
        {shots.map((shot, index) => (
          <figure key={shot.src} className={styles.item}>
            <button
              type="button"
              className={styles.thumb}
              aria-label={`View full size: ${shot.caption}`}
              onClick={() => {
                setClosing(false);
                setOpenIndex(index);
              }}
            >
              {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
              <img src={shot.src} alt={shot.alt} loading="lazy" />
            </button>
            <figcaption className={styles.caption}>{shot.caption}</figcaption>
          </figure>
        ))}
      </div>
      {open && (
        <div
          className={`${styles.backdrop} ${closing ? styles.closing : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={open.caption}
          onClick={close}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              close();
            }
          }}
          onAnimationEnd={() => {
            if (closing) {
              setOpenIndex(null);
              setClosing(false);
            }
          }}
        >
          <div className={styles.lightbox} onClick={(e) => e.stopPropagation()}>
            <button type="button" className={styles.close} aria-label="Close" onClick={close}>
              ✕
            </button>
            {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
            <img src={open.src} alt={open.alt} />
            <p className={styles.lightboxCaption}>{open.caption}</p>
          </div>
        </div>
      )}
    </>
  );
}
