import Link from 'next/link';
import type { BlogPost } from '../lib/blogPosts';
import styles from './BlogIndex.module.css';

function formatDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

const DEFAULT_IMAGE = '/screenshots/board.png';

export function BlogCard({ post }: { post: BlogPost }) {
  const imageSrc = post.image || DEFAULT_IMAGE;
  return (
    <Link href={`/blog/${post.slug}`} className={styles.card}>
      <div className={styles.imageContainer}>
        {/* biome-ignore lint/performance/noImgElement: Static asset in docs */}
        <img src={imageSrc} alt={post.title} className={styles.image} />
      </div>
      <div className={styles.content}>
        <span className={styles.date}>{formatDate(post.date)}</span>
        <h3 className={styles.cardTitle}>{post.title}</h3>
      </div>
    </Link>
  );
}
