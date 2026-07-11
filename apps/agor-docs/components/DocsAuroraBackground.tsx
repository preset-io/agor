'use client';

import { useEffect, useState } from 'react';
import Aurora from './Aurora/Aurora';

/**
 * Site-wide backdrop for docs/blog pages — successor to the old tsparticles
 * DocsBackground. Renders the ReactBits Aurora fixed behind the layout,
 * dimmed so content stays readable. The landing page is unaffected (its
 * shell has an opaque background and its own aurora band).
 */
export function DocsAuroraBackground() {
  const [enabled, setEnabled] = useState(false);

  // WebGL + continuous animation: skip entirely for reduced-motion users.
  useEffect(() => {
    setEnabled(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  if (!enabled) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        opacity: 0.35,
      }}
    >
      {/* speed 0.6 = 40% slower than default; docs pages should shimmer, not swim.
          The landing page is unaffected (opaque shell + its own aurora band). */}
      <Aurora
        colorStops={['#2e9a92', '#34e6c4', '#7ad9ff']}
        amplitude={0.9}
        blend={1}
        speed={0.6}
      />
    </div>
  );
}
