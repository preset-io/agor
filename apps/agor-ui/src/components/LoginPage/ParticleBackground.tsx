/**
 * Particle Background for Login Page
 *
 * Lazy-loaded particle animation using tsparticles-slim
 */

import type { Container } from '@tsparticles/engine';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import { loadSlim } from '@tsparticles/slim';
import { memo, useEffect, useId, useState } from 'react';
import { mellowParticleOptions } from '../../utils/particleConfig';

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

  if (!init) {
    return null;
  }

  return (
    <Particles
      id={particlesId}
      particlesLoaded={particlesLoaded}
      options={mellowParticleOptions}
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
