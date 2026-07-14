import Link from 'next/link';

export const metadata = {
  title: 'Page not found – agor',
  robots: { index: false, follow: false },
};

/**
 * Styled 404 for the static export (out/404.html). Rendered inside the root
 * layout, so it inherits the aurora background and marketing fonts. Inline
 * styles keep it dependency-free — it must not pull in the Nextra docs
 * layout, which needs a page map.
 */
export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '16px',
        padding: '24px',
        textAlign: 'center',
        fontFamily: 'var(--font-body), system-ui, sans-serif',
      }}
    >
      <p
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono-label), ui-monospace, monospace',
          fontSize: '0.85rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: '#34e6c4',
        }}
      >
        404 — Page not found
      </p>
      <h1
        style={{
          margin: 0,
          fontFamily: 'var(--font-display), system-ui, sans-serif',
          fontSize: 'clamp(1.8rem, 5vw, 3rem)',
          lineHeight: 1.15,
        }}
      >
        This page drifted off the board
      </h1>
      <p style={{ margin: 0, maxWidth: '42ch', opacity: 0.75 }}>
        The link may be outdated or the page may have moved. Try the docs or head back home.
      </p>
      <div style={{ display: 'flex', gap: '12px', marginTop: '8px', flexWrap: 'wrap' }}>
        <Link
          href="/"
          style={{
            padding: '10px 22px',
            borderRadius: '999px',
            background: '#34e6c4',
            color: '#04110e',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Back to home
        </Link>
        <Link
          href="/guide"
          style={{
            padding: '10px 22px',
            borderRadius: '999px',
            border: '1px solid rgba(52, 230, 196, 0.4)',
            color: 'inherit',
            textDecoration: 'none',
          }}
        >
          Browse the docs
        </Link>
      </div>
    </main>
  );
}
