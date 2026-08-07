'use client';

import '@scalar/api-reference-react/style.css';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

const ApiReferenceReact = dynamic(
  () =>
    import('@scalar/api-reference-react').then(
      ({ ApiReferenceReact: ApiReference }) => ApiReference
    ),
  { ssr: false, loading: () => <p className="agor-api-reference-loading">Loading API schema…</p> }
);

const customCss = `
  .scalar-app { --scalar-color-accent: #2e9a92; }
  .dark-mode { --scalar-color-accent: #7fe8df; }
  .references-layout { min-height: 70vh; }
  .scalar-app .sidebar { border-radius: 14px 0 0 14px; }
`;

/** Render the checked-in release schema while following Nextra's theme. */
export function ApiReference() {
  const [darkMode, setDarkMode] = useState(true);

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => setDarkMode(root.classList.contains('dark'));
    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="agor-api-reference-page">
      <div className="agor-api-reference">
        <ApiReferenceReact
          configuration={{
            url: '/openapi/agor.json',
            theme: 'default',
            layout: 'modern',
            darkMode,
            hideDarkModeToggle: true,
            documentDownloadType: 'none',
            customCss,
          }}
        />
      </div>
    </div>
  );
}
