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

export function BlogCard({ post }: { post: BlogPost }) {
  return (
    <Link href={`/blog/${post.slug}`} className={styles.card}>
      <div className={styles.imageContainer}>
        {post.image ? (
          // biome-ignore lint/performance/noImgElement: Static asset in docs
          <img src={post.image} alt={post.title} className={styles.image} />
        ) : (
          <span className={styles.placeholderIcon}>📝</span>
        )}
      </div>
      <div className={styles.content}>
        <span className={styles.date}>{formatDate(post.date)}</span>
        <h3 className={styles.cardTitle}>{post.title}</h3>
        <p className={styles.description}>{post.description}</p>
      </div>
    </Link>
  );
}
