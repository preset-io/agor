/**
 * Docs Background - Subtle particles behind the layout
 * Add this to _app.tsx to have particles behind sidebars/panels
 */

import type { Container } from '@tsparticles/engine';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import { loadSlim } from '@tsparticles/slim';
import { useEffect, useId, useMemo, useState } from 'react';

export function DocsBackground() {
  const particlesId = useId();
  const [init, setInit] = useState(false);

  useEffect(() => {
    initParticlesEngine(async (engine) => {
      await loadSlim(engine);
    }).then(() => {
      setInit(true);
    });
  }, []);

  const particlesLoaded = async (container?: Container): Promise<void> => {
    console.log('Docs particles loaded');
  };

  const options = useMemo(
    () => ({
      background: {
        color: {
          value: 'transparent',
        },
      },
      fpsLimit: 60,
      interactivity: {
        events: {
          onHover: {
            enable: true,
            mode: 'attract',
          },
          resize: {
            enable: true,
          },
        },
        modes: {
          attract: {
            distance: 200,
            duration: 0.4,
            speed: 3,
          },
        },
      },
      particles: {
        color: {
          value: '#2e9a92',
        },
        links: {
          color: '#2e9a92',
          distance: 150,
          enable: true,
          opacity: 0.2, // More subtle
          width: 1,
        },
        move: {
          direction: 'none' as const,
          enable: true,
          outModes: {
            default: 'bounce' as const,
          },
          random: false,
          speed: 1, // Same as login page
          straight: false,
        },
        number: {
          density: {
            enable: true,
            width: 1920,
            height: 1080,
          },
          value: 150, // Less particles
        },
        opacity: {
          value: 0.4, // More muted
        },
        shape: {
          type: 'circle',
        },
        size: {
          value: { min: 1, max: 3 }, // Smaller particles
        },
      },
      detectRetina: true,
    }),
    []
  );

  if (!init) {
    return null;
  }

  return (
    <Particles
      id={particlesId}
      particlesLoaded={particlesLoaded}
      options={options}
      style={{
        position: 'fixed',
        width: '100%',
        height: '100%',
        top: 0,
        left: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
