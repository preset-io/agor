/**
 * Particle Background for Login Page
 *
 * Lazy-loaded particle animation using tsparticles-slim
 */

import type { Container } from '@tsparticles/engine';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import { loadSlim } from '@tsparticles/slim';
import { theme } from 'antd';
import { memo, useEffect, useId, useMemo, useState } from 'react';
import { getMellowParticleOptions } from '../../utils/particleConfig';

export const ParticleBackground = memo(function ParticleBackground() {
  const particlesId = useId();
  const { token } = theme.useToken();
  const particleOptions = useMemo(
    () => getMellowParticleOptions(token.colorPrimary),
    [token.colorPrimary]
  );
  const [init, setInit] = useState(false);

  useEffect(() => {
    initParticlesEngine(async (engine) => {
      await loadSlim(engine);
    }).then(() => {
      setInit(true);
    });
  }, []);

  const particlesLoaded = async (_container?: Container): Promise<void> => {
    // no-op
  };

  if (!init) {
    return null;
  }

  return (
    <Particles
      id={particlesId}
      particlesLoaded={particlesLoaded}
      options={particleOptions}
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
