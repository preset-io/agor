/**
 * Particle Background for Login Page
 *
 * Lazy-loaded particle animation using tsparticles-slim
 */

import type { Container } from '@tsparticles/engine';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import { loadSlim } from '@tsparticles/slim';
import { memo, useEffect, useId, useMemo, useState } from 'react';

export const ParticleBackground = memo(function ParticleBackground() {
  const particlesId = useId();
  const [init, setInit] = useState(false);

  useEffect(() => {
    initParticlesEngine(async (engine) => {
      await loadSlim(engine);
    }).then(() => {
      console.log('tsParticles initialized');
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
            mode: 'attract', // Changed from repulse to attract
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
            distance: 350, // Slightly larger radius
            duration: 0.4, // Smoother transition
            speed: 6, // Bit faster attraction
            factor: 3, // Moderate pull strength
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
          opacity: 0.3, // More visible links
          width: 1.5,
        },
        move: {
          direction: 'none' as const,
          enable: true,
          outModes: {
            default: 'bounce' as const,
          },
          random: false,
          speed: 1.5, // Bit more lively
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
          value: 300, // Double the particles!
        },
        opacity: {
          value: 0.6, // More visible for brand color
        },
        shape: {
          type: 'circle',
        },
        size: {
          value: { min: 2, max: 5 }, // Bigger particles
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
      }}
    />
  );
});
