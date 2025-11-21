/**
 * Particle Background Component
 *
 * Interactive particle animation using tsparticles-slim with Agor brand colors
 */

import type { Container } from '@tsparticles/engine';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import { loadSlim } from '@tsparticles/slim';
import { useEffect, useId, useMemo, useState } from 'react';

export function ParticleBackground() {
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
    console.log('Particles loaded:', container);
  };

  const options = useMemo(
    () => ({
      background: {
        color: {
          value: 'transparent',
        },
      },
      fpsLimit: 120,
      interactivity: {
        events: {
          onClick: {
            enable: true,
            mode: 'push',
          },
          onHover: {
            enable: true,
            mode: 'attract',
          },
          resize: {
            enable: true,
          },
        },
        modes: {
          push: {
            quantity: 4,
          },
          attract: {
            distance: 300,
            duration: 0.3,
            speed: 5,
          },
        },
      },
      particles: {
        color: {
          value: '#2e9a92', // Agor teal brand color
        },
        links: {
          color: '#2e9a92',
          distance: 150,
          enable: true,
          opacity: 0.3,
          width: 1.5,
        },
        move: {
          direction: 'none' as const,
          enable: true,
          outModes: {
            default: 'bounce' as const,
          },
          random: false,
          speed: 1,
          straight: false,
        },
        collisions: {
          enable: true,
          mode: 'bounce' as const,
        },
        number: {
          density: {
            enable: true,
            width: 1920,
            height: 1080,
          },
          value: 150, // Lighter density for docs page
        },
        opacity: {
          value: 0.4, // More subtle for docs
        },
        shape: {
          type: 'circle',
        },
        size: {
          value: { min: 2, max: 5 },
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
        position: 'absolute',
        width: '100%',
        height: '100%',
        top: 0,
        left: 0,
        zIndex: 0,
        pointerEvents: 'none', // Allow clicks to pass through
      }}
    />
  );
}
