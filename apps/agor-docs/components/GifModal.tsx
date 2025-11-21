import { useState } from 'react';
import styles from './GifModal.module.css';

interface GifModalProps {
  src: string;
  alt: string;
  caption: string;
}

export function GifModal({ src, alt, caption }: GifModalProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <div className={styles.gifItem} onClick={() => setIsOpen(true)}>
        {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
        <img src={src} alt={alt} />
        <p>{caption}</p>
      </div>

      {isOpen && (
        <div className={styles.modal} onClick={() => setIsOpen(false)}>
          <div className={styles.modalContent} onClick={e => e.stopPropagation()}>
            <button type="button" className={styles.closeButton} onClick={() => setIsOpen(false)}>
              ✕
            </button>
            {/* biome-ignore lint/performance/noImgElement: Using img for static assets in docs */}
            <img src={src} alt={alt} />
            <p className={styles.modalCaption}>{caption}</p>
          </div>
        </div>
      )}
    </>
  );
}
