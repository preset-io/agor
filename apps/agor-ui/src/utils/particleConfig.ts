/**
 * Shared tsParticles configuration
 *
 * Provides a consistent, mellow particle effect across the app
 */

export const getMellowParticleOptions = (color: string) =>
  ({
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
        value: color,
      },
      links: {
        color,
        distance: 150,
        enable: true,
        opacity: 0.2,
        width: 1,
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
      number: {
        density: {
          enable: true,
          width: 1920,
          height: 1080,
        },
        value: 150,
      },
      opacity: {
        value: 0.4,
      },
      shape: {
        type: 'circle',
      },
      size: {
        value: { min: 1, max: 3 },
      },
    },
    detectRetina: true,
  }) as const;
