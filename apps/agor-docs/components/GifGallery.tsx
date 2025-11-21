import styles from './GifGallery.module.css';
import { GifModal } from './GifModal';

const gifs = [
  {
    src: '/Area.gif',
    alt: 'Spatial 2D Canvas',
    caption: 'Spatial canvas with worktrees and zones',
  },
  {
    src: '/Convo.gif',
    alt: 'AI Conversation in Action',
    caption: 'Rich web UI for AI conversations',
  },
  {
    src: '/Settings.gif',
    alt: 'Settings and Configuration',
    caption: 'MCP servers and worktree management',
  },
  {
    src: '/Social.gif',
    alt: 'Real-time Multiplayer',
    caption: 'Live collaboration with cursors and comments',
  },
];

export function GifGallery() {
  return (
    <div className={styles.gifGrid}>
      {gifs.map((gif) => (
        <GifModal key={gif.src} src={gif.src} alt={gif.alt} caption={gif.caption} />
      ))}
    </div>
  );
}
